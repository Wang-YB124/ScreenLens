const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const POWERSHELL = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const WORKER = path.join(__dirname, '..', 'ocr', 'ocr-worker.ps1');
const CJK_RANGE = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';

function tidyText(input) {
  if (!input) return '';
  let text = String(input).replace(/\u00a0/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '');
  text = text.replace(new RegExp(`([${CJK_RANGE}])\\s+(?=[${CJK_RANGE}])`, 'g'), '$1');
  text = text.replace(
    new RegExp(`([${CJK_RANGE}])\\s+(?=[，。！？；：、（）【】《》“”‘’…—·])`, 'g'),
    '$1',
  );
  text = text.replace(new RegExp(`([，。！？；：、（）【】《》“”‘’…—·])\\s+`, 'g'), '$1');
  text = text.replace(/[ \t]{2,}/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

function countCjk(text) {
  const matches = String(text || '').match(new RegExp(`[${CJK_RANGE}]`, 'g'));
  return matches ? matches.length : 0;
}

function latinScore(text) {
  return String(text || '').replace(/[^A-Za-z0-9]/g, '').length;
}

class OcrService extends EventEmitter {
  constructor({ dir }) {
    super();
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.reqFile = path.join(dir, 'ocr-request.json');
    this.proc = null;
    this.current = null;
    this.queue = [];
    this.seq = 0;
    this.starting = null;
    this.languages = [];
    this.available = false;
    this.stderr = '';
    this.failures = 0;
    this.zhLang = null;
    this.enLang = null;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.spawnWorker();
      const res = await this.request({ action: 'ping' }, 25000);
      this.languages = res.languages || [];
      this.zhLang = this.languages.find((lang) => /^zh/i.test(lang)) || null;
      this.enLang = this.languages.find((lang) => /^en/i.test(lang)) || null;
      this.available = true;
      this.emit('ready', { languages: this.languages });
      return { languages: this.languages, maxDim: res.maxDim };
    })().catch((err) => {
      this.starting = null;
      this.available = false;
      this.emit('error', err);
      throw err;
    });
    return this.starting;
  }

  spawnWorker() {
    if (this.proc) return;
    const proc = spawn(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WORKER, this.reqFile],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.proc = proc;
    this.stdoutBuffer = '';

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this.handleStdout(chunk));

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
      this.emit('log', chunk);
    });

    proc.on('error', (err) => {
      if (this.proc === proc) this.handleDeath(err);
    });
    proc.on('close', (code) => {
      if (this.proc === proc) this.handleDeath(new Error(`OCR worker exited (${code})`));
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    let idx;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line.startsWith('@@')) continue;
      let message;
      try {
        message = JSON.parse(line.slice(2));
      } catch (err) {
        this.failCurrent(new Error('OCR worker returned invalid JSON'));
        continue;
      }
      const current = this.current;
      if (!current) continue;
      if (message.id !== undefined && current.id !== message.id) continue;
      clearTimeout(current.timer);
      this.current = null;
      if (message.ok) {
        this.failures = 0;
        current.resolve(message);
      } else {
        current.reject(new Error(message.error || 'OCR failed'));
      }
      this.pump();
    }
  }

  handleDeath(err) {
    if (this.proc) {
      try { this.proc.stdin.end(); } catch {}
      this.proc = null;
    }
    const current = this.current;
    if (current) {
      clearTimeout(current.timer);
      this.current = null;
      current.reject(err);
    }
    this.failures += 1;
    if (this.queue.length && this.failures < 3) {
      setTimeout(() => this.pump(), 350);
    } else if (this.failures >= 3) {
      this.available = false;
      const queued = this.queue.splice(0);
      for (const item of queued) item.reject(new Error('OCR engine is unavailable'));
      this.emit('error', new Error('OCR engine stopped repeatedly'));
    }
  }

  failCurrent(err) {
    if (!this.current) return;
    clearTimeout(this.current.timer);
    this.current.reject(err);
    this.current = null;
    this.pump();
  }

  pump() {
    if (this.current || !this.queue.length) return;
    if (!this.proc) {
      try {
        this.spawnWorker();
      } catch (err) {
        const item = this.queue.shift();
        item.reject(err);
        return;
      }
    }
    const item = this.queue.shift();
    const id = ++this.seq;
    try {
      fs.writeFileSync(this.reqFile, JSON.stringify({ ...item.payload, id }), 'utf8');
      this.proc.stdin.write('run\n');
    } catch (err) {
      item.reject(err);
      this.pump();
      return;
    }
    const timer = setTimeout(() => {
      if (this.current && this.current.id === id) {
        this.current = null;
        item.reject(new Error('OCR timed out'));
        try { this.proc.kill(); } catch {}
        this.proc = null;
        this.failures += 1;
        this.pump();
      }
    }, item.timeout);
    this.current = { id, resolve: item.resolve, reject: item.reject, timer };
  }

  request(payload, timeout = 20000) {
    return new Promise((resolve, reject) => {
      this.queue.push({ payload, timeout, resolve, reject });
      this.pump();
    });
  }

  async rawOcr(imagePath, lang) {
    const res = await this.request({
      action: 'ocr',
      image: imagePath,
      lang,
    });
    return this.postProcess(res, lang);
  }

  async listWindows({ excludePid = 0 } = {}) {
    const res = await this.request({ action: 'windows', excludePid }, 15000);
    return Array.isArray(res.windows) ? res.windows : [];
  }

  async captureRect(rect, imagePath) {
    const res = await this.request({
      action: 'capture',
      image: imagePath,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    }, 15000);
    if (!res.capture || !res.capture.path) throw new Error('屏幕截图失败');
    return res.capture;
  }

  postProcess(res, engine) {
    const text = tidyText(res.text || '');
    const lines = (res.lines || []).map((line) => ({
      ...line,
      text: tidyText(line.text || ''),
    })).filter((line) => line.text);
    return {
      ok: true,
      text,
      rawText: res.text || '',
      lines,
      engine,
      cjk: countCjk(text),
      width: res.width,
      height: res.height,
      ocrMs: res.ms,
      captureMs: res.captureMs,
    };
  }

  async recognizeImage(imagePath, { lang = 'auto' } = {}) {
    if (lang !== 'auto') {
      return this.rawOcr(imagePath, lang);
    }
    if (!this.zhLang) {
      if (this.enLang) return this.rawOcr(imagePath, this.enLang);
      throw new Error('系统没有安装中文或英文 OCR 语言包');
    }
    const zh = await this.rawOcr(imagePath, this.zhLang);
    if (zh.cjk > 0 || !this.enLang) return zh;
    const en = await this.rawOcr(imagePath, this.enLang).catch(() => null);
    if (en && latinScore(en.text) >= latinScore(zh.text)) return en;
    return zh;
  }

  async recognizeRegion(rect, { imagePath, lang = 'auto' } = {}) {
    const autoLang = this.zhLang || this.enLang;
    if (lang === 'auto' && !autoLang) {
      throw new Error('系统没有安装中文或英文 OCR 语言包');
    }
    const firstLang = lang === 'auto' ? autoLang : lang;
    const res = await this.request({
      action: 'capture',
      ocr: true,
      image: imagePath,
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      lang: firstLang,
    }, 25000);
    const first = this.postProcess(res, firstLang);
    if (lang !== 'auto') return { ...first, captureMs: res.captureMs };
    if (first.cjk > 0 || !this.enLang || firstLang === this.enLang) {
      return { ...first, captureMs: res.captureMs };
    }
    const en = await this.rawOcr(imagePath, this.enLang).catch(() => null);
    if (en && latinScore(en.text) >= latinScore(first.text)) {
      return { ...en, captureMs: res.captureMs };
    }
    return { ...first, captureMs: res.captureMs };
  }

  async recognizeWindow(hwnd, { imagePath, lang = 'auto' } = {}) {
    const autoLang = this.zhLang || this.enLang;
    if (lang === 'auto' && !autoLang) {
      throw new Error('系统没有安装中文或英文 OCR 语言包');
    }
    const firstLang = lang === 'auto' ? autoLang : lang;
    const res = await this.request({
      action: 'capture',
      ocr: true,
      hwnd: String(hwnd),
      image: imagePath,
      lang: firstLang,
    }, 25000);
    const first = this.postProcess(res, firstLang);
    const windowRect = res.windowRect || null;
    if (lang !== 'auto' || first.cjk > 0 || !this.enLang || firstLang === this.enLang) {
      return { ...first, captureMs: res.captureMs, windowRect };
    }
    const en = await this.rawOcr(imagePath, this.enLang).catch(() => null);
    if (en && latinScore(en.text) >= latinScore(first.text)) {
      return { ...en, captureMs: res.captureMs, windowRect };
    }
    return { ...first, captureMs: res.captureMs, windowRect };
  }

  restart() {
    this.stop();
    this.starting = null;
    this.failures = 0;
    this.available = false;
    return this.start();
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.stdin.write('quit\n'); } catch {}
      setTimeout(() => { try { proc.kill(); } catch {} }, 400);
    }
    this.failCurrent(new Error('OCR stopped'));
  }
}

module.exports = { OcrService, tidyText, countCjk };
