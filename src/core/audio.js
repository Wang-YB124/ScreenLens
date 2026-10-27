const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { BrowserWindow, desktopCapturer, screen } = require('electron');
const { createRealtimeWindow, sendRealtimeInit } = require('../windows/realtimeWindow');
const { translateAI, translateFree, LANG_NAMES } = require('./translate');
const { providerLabel } = require('./llm');
const T2S = require('./t2s.json');

const HALLUCINATION_PATTERNS = [
  /^(谢谢观看|感谢观看|请不吝点赞|字幕由|字幕组|訂閱|订阅|小铃铛|明镜与点点)/,
  /^(thanks?\s+for\s+watching|thank\s+you\s+for\s+watching|please\s+subscribe|amara\.org|subtitles\s+by)/i,
  /^[\(\[（【][\s\S]*[\)\]）】]$/,
  /^(\(|\[)?\s*(buzz|music|applause|laughter|silence|blank_audio|inaudible|no speech|the end)\s*(\)|\])?$/i,
  /^\((x|×)\s*\d+\)$/i,
];

function toSimplified(value) {
  let output = '';
  for (const char of String(value || '')) output += T2S[char] || char;
  return output;
}

function tidySpeech(value) {
  let text = String(value || '')
    .replace(/\r/g, ' ')
    .replace(/\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^[\-–—\s]+/, '').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
  return text;
}

function trimOverlap(previous, next) {
  if (!previous || !next) return next;
  if (previous === next) return '';
  const max = Math.min(previous.length, next.length);
  const floor = /[\u3400-\u9fff]/.test(next) ? 3 : 8;
  for (let size = max; size >= floor; size -= 1) {
    if (previous.slice(-size) === next.slice(0, size)) {
      return next.slice(size).trim();
    }
  }
  return next;
}

function looksLikeHallucination(text, language = 'zh') {
  if (!text) return true;
  if (HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  const spoken = text.replace(/[^\p{L}\p{N}]+/gu, '');
  if (spoken.length < 1) return true;
  const hasCjk = /[㐀-鿿]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  if (language === 'zh' && !hasCjk && hasLatin) return true;
  if (language === 'en' && !hasLatin) return true;
  return false;
}

class AudioController {
  constructor({ settings, tempDir, rootDir, onStateChange, notify }) {
    this.settings = settings;
    this.tempDir = tempDir;
    this.rootDir = rootDir;
    this.onStateChange = onStateChange || (() => {});
    this.notify = notify || (() => {});
    this.active = false;
    this.win = null;
    this.capture = null;
    this.busy = false;
    this.queue = [];
    this.seq = 0;
    this.proc = null;
    this.abort = null;
    this.gen = 0;
    this.cache = new Map();
    this.prevRaw = '';
    this.uiText = '';
    this.lastErrorAt = 0;
    this.fallbackNotified = false;
  }

  isActive() {
    return this.active;
  }

  modelInfo() {
    const base = path.join(this.rootDir, 'vendor', 'whisper');
    const runtime = path.join(base, 'runtime', 'whisper-cli.exe');
    const models = path.join(base, 'models');
    const candidates = [
      { name: 'Whisper small (q5_1)', file: 'ggml-small-q5_1.bin', min: 150 * 1024 * 1024 },
      { name: 'Whisper base (q5_1)', file: 'ggml-base-q5_1.bin', min: 40 * 1024 * 1024 },
    ];
    if (fs.existsSync(runtime)) {
      for (const candidate of candidates) {
        const file = path.join(models, candidate.file);
        try {
          const stat = fs.statSync(file);
          if (stat.size >= candidate.min) {
            return { ready: true, runtime, model: file, name: candidate.name, reason: '' };
          }
        } catch {}
      }
    }
    return {
      ready: false,
      runtime,
      model: '',
      name: 'Whisper',
      reason: '未找到本地 Whisper 运行文件或模型，请先运行 scripts/fetch-whisper.ps1',
    };
  }

  send(payload) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('realtime:update', payload);
    }
  }

  refreshSettings() {
    if (this.win && !this.win.isDestroyed()) {
      sendRealtimeInit(this.win, this.settings.get());
    }
  }

  async start() {
    if (this.active) return { ok: true, active: true };
    const info = this.modelInfo();
    if (!info.ready) {
      this.notify('音频字幕无法启动', info.reason);
      return { ok: false, error: info.reason };
    }
    const settings = this.settings.get();
    const source = settings.audio.source === 'microphone' ? 'microphone' : 'system';
    this.active = true;
    this.busy = false;
    this.queue = [];
    this.seq = 0;
    this.abort = null;
    this.gen += 1;
    this.cache.clear();
    this.prevRaw = '';
    this.uiText = '';
    this.lastErrorAt = 0;
    this.fallbackNotified = false;
    this.onStateChange({ audioActive: true });
    try {
      const display = screen.getPrimaryDisplay();
      this.win = createRealtimeWindow({
        rect: display.workArea,
        settings,
        scope: '音频',
      });
      this.win.on('closed', () => {
        this.win = null;
        if (this.active) this.stop({ silent: true });
      });
      const waiting = {
        status: 'waiting',
        original: '',
        translated: '',
        message: source === 'microphone' ? '正在聆听麦克风…' : '正在聆听系统声音…',
      };
      this.send(waiting);
      this.win.webContents.on('did-finish-load', () => {
        setTimeout(() => {
          if (this.active) this.send(waiting);
        }, 300);
      });
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      const sourceInfo = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
      this.capture = new BrowserWindow({
        show: false,
        width: 200,
        height: 120,
        frame: false,
        skipTaskbar: true,
        webPreferences: {
          preload: path.join(__dirname, '..', 'preload.js'),
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      this.capture.webContents.on('did-finish-load', () => {
        if (!this.active || !this.capture || this.capture.isDestroyed()) return;
        this.capture.webContents.send('audio:init', {
          sourceId: sourceInfo ? sourceInfo.id : '',
          source,
          chunkMs: settings.audio.chunkMs,
          overlapMs: settings.audio.overlapMs,
        });
      });
      this.capture.loadFile(path.join(__dirname, '..', 'renderer', 'audio-capture', 'index.html'));
    } catch (err) {
      const message = String(err.message || '音频捕获初始化失败');
      this.notify('音频字幕启动失败', message);
      this.stop({ silent: true });
      return { ok: false, error: message };
    }
    const label = source === 'microphone' ? '麦克风' : '系统声音';
    this.notify('音频字幕已开启', `正在聆听${label} · 本地 Whisper 识别 · 点击按钮或字幕 × 停止`);
    return { ok: true, active: true };
  }

  pushChunk(buffer) {
    if (!this.active) return;
    let data;
    try {
      data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    } catch {
      return;
    }
    if (data.length < 1024) return;
    this.seq += 1;
    const file = path.join(this.tempDir, `asr-${process.pid}-${Date.now()}-${this.seq}.wav`);
    try {
      fs.writeFileSync(file, data);
    } catch {
      return;
    }
    this.queue.push({ file, at: Date.now() });
    while (this.queue.length > 3) {
      const dropped = this.queue.shift();
      try { fs.unlink(dropped.file, () => {}); } catch {}
    }
    this.pump();
  }

  onCaptureStatus(payload) {
    if (!this.active || !payload) return;
    if (payload.status === 'error') {
      this.notify('音频采集失败', String(payload.message || '请检查系统声音输出设备'));
      this.stop({ silent: true });
    }
  }

  pump() {
    if (!this.active || this.busy || !this.queue.length) return;
    const item = this.queue.shift();
    this.busy = true;
    this.recognize(item.file)
      .then((text) => {
        if (!this.active) return;
        this.handleText(text);
      })
      .catch((err) => {
        if (!this.active) return;
        if (Date.now() - this.lastErrorAt > 6000) {
          this.lastErrorAt = Date.now();
          this.send({
            status: 'error',
            original: this.uiText,
            translated: '',
            message: `语音识别暂不可用：${String(err.message || '请稍后重试').slice(0, 80)}`,
          });
        }
      })
      .finally(() => {
        try { fs.unlink(item.file, () => {}); } catch {}
        this.busy = false;
        if (this.active) this.pump();
      });
  }

  recognize(file) {
    const info = this.modelInfo();
    if (!info.ready) throw new Error('本地 Whisper 模型不可用');
    const settings = this.settings.get();
    const language = settings.audio.language === 'en' ? 'en' : 'zh';
    const prompt = language === 'zh' ? '以下是普通话的句子。' : 'The following is an English sentence.';
    const threads = Math.max(4, Math.min(8, (os.cpus() || []).length || 4));
    const base = file.replace(/\.wav$/i, '');
    const output = `${base}-out`;
    const args = [
      '-m', info.model,
      '-f', file,
      '-l', language,
      '-t', String(threads),
      '-nt',
      '-otxt',
      '-of', output,
      '--prompt', prompt,
    ];
    return new Promise((resolve, reject) => {
      let stderr = '';
      let settled = false;
      let proc;
      try {
        proc = spawn(info.runtime, args, {
          cwd: path.dirname(info.runtime),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch (err) {
        reject(err);
        return;
      }
      this.proc = proc;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch {}
        reject(new Error('语音识别超时'));
      }, 20000);
      proc.stderr.on('data', (chunk) => {
        stderr = (stderr + String(chunk)).slice(-600);
      });
      proc.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        reject(err);
      });
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        try {
          const text = fs.readFileSync(`${output}.txt`, 'utf8');
          resolve(text.replace(/^\uFEFF/, '').trim());
        } catch {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Whisper 退出 ${code}`));
          } else {
            resolve('');
          }
        } finally {
          try { fs.unlink(`${output}.txt`, () => {}); } catch {}
        }
      });
    });
  }

  handleText(raw) {
    const settings = this.settings.get();
    const language = settings.audio.language === 'en' ? 'en' : 'zh';
    const cleaned = toSimplified(tidySpeech(raw));
    if (!cleaned || looksLikeHallucination(cleaned, language)) return;
    const display = trimOverlap(this.prevRaw, cleaned);
    this.prevRaw = cleaned;
    if (!display || looksLikeHallucination(display, language)) return;
    this.uiText = display;
    const sourceCode = language === 'en' ? 'en' : 'zh-CN';
    const realtime = settings.realtime || {};
    const target = realtime.targetLang && realtime.targetLang !== 'auto'
      ? realtime.targetLang
      : settings.targetLang;
    const same = (sourceCode === 'zh-CN' && String(target).startsWith('zh'))
      || (sourceCode === 'en' && target === 'en');
    if (same) {
      this.send({
        status: 'done',
        original: '',
        translated: display,
        direction: sourceCode === 'zh-CN' ? '中文' : 'EN',
        provider: '原文',
        domain: 'general',
      });
      return;
    }
    const directionLabel = `${sourceCode === 'zh-CN' ? '中文' : 'EN'} → ${LANG_NAMES[target] || target}`;
    this.send({
      status: 'loading',
      original: display,
      translated: '',
      direction: directionLabel,
      domain: 'general',
    });
    this.translate(display, sourceCode, target, directionLabel);
  }

  async translate(text, source, target, directionLabel) {
    const cacheKey = `${text}\u0000${target}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.send({
        status: 'done',
        original: text,
        translated: cached.text,
        direction: directionLabel,
        provider: cached.provider,
        domain: 'general',
      });
      return;
    }
    if (this.abort) {
      try { this.abort.abort(); } catch {}
      this.abort = null;
    }
    const controller = new AbortController();
    this.abort = controller;
    const gen = ++this.gen;
    const settings = this.settings.get();
    const canAI = this.settings.hasProvider();
    const engine = settings.realtime.engine === 'free' ? 'free' : (canAI ? 'ai' : 'free');
    let provider = engine === 'ai' ? providerLabel(settings.provider) : '免费翻译';
    try {
      let output = '';
      if (engine === 'ai' && this.settings.hasProvider()) {
        try {
          const result = await translateAI(text, source, target, {
            provider: settings.provider,
            signal: controller.signal,
            domain: 'general',
            realtime: true,
            onDelta: (delta) => {
              if (gen !== this.gen || !this.active) return;
              output += delta;
              this.send({
                status: 'streaming',
                original: text,
                translated: output,
                direction: directionLabel,
                provider: providerLabel(settings.provider),
                domain: 'general',
              });
            },
          });
          output = result.text;
        } catch (err) {
          if (controller.signal.aborted || !this.active) return;
          if (!settings.freeTranslation) throw err;
          const fallback = await translateFree(text, source, target, { signal: controller.signal });
          output = fallback.text;
          provider = '免费翻译';
          if (!this.fallbackNotified) {
            this.fallbackNotified = true;
            this.notify('音频字幕已切换免费通道', `AI 翻译不可用：${String(err.message || '').slice(0, 100)}`);
          }
        }
      } else {
        const result = await translateFree(text, source, target, { signal: controller.signal });
        output = result.text;
        provider = result.provider;
      }
      if (!this.active || gen !== this.gen) return;
      if (output) {
        this.remember(cacheKey, { text: output, provider });
        this.send({
          status: 'done',
          original: text,
          translated: output,
          direction: directionLabel,
          provider,
          domain: 'general',
        });
      }
    } catch (err) {
      if (controller.signal.aborted || !this.active || gen !== this.gen) return;
      this.send({
        status: 'error',
        original: text,
        translated: '',
        direction: directionLabel,
        message: String(err.message || '翻译暂不可用').slice(0, 120),
      });
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  remember(key, value) {
    if (this.cache.size > 100) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
    this.cache.set(key, value);
  }

  stop({ silent = false } = {}) {
    if (!this.active && !this.win && !this.capture) return;
    this.active = false;
    this.gen += 1;
    if (this.abort) {
      try { this.abort.abort(); } catch {}
      this.abort = null;
    }
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
    this.queue = [];
    if (this.capture && !this.capture.isDestroyed()) {
      try { this.capture.destroy(); } catch {}
    }
    this.capture = null;
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch {}
    }
    this.win = null;
    this.onStateChange({ audioActive: false });
    if (!silent) {
      // The user stopped audio subtitles; no toast needed, the bar disappears.
    }
  }
}

module.exports = { AudioController };