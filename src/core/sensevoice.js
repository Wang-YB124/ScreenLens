const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');

const SENSE_LANGS = new Set(['zh', 'en', 'ja', 'ko', 'yue']);

class SenseVoiceService {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.proc = null;
    this.language = '';
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
  }

  info() {
    const base = path.join(this.rootDir, 'vendor', 'sensevoice');
    const server = path.join(base, 'server', 'sensevoice-server.exe');
    const model = path.join(base, 'models', 'model.int8.onnx');
    const tokens = path.join(base, 'models', 'tokens.txt');
    const result = {
      ready: false,
      name: 'SenseVoice int8',
      server,
      model,
      tokens,
      reason: '',
    };
    try {
      if (!fs.existsSync(server)) throw new Error('缺少 SenseVoice 服务文件');
      if (!fs.existsSync(model) || fs.statSync(model).size < 100 * 1024 * 1024) throw new Error('缺少 SenseVoice 模型');
      if (!fs.existsSync(tokens) || fs.statSync(tokens).size < 100 * 1024) throw new Error('缺少 SenseVoice tokens');
      result.ready = true;
      result.reason = '';
    } catch (err) {
      result.reason = String(err.message || 'SenseVoice 不可用');
    }
    return result;
  }

  ensure(language = 'auto') {
    const lang = SENSE_LANGS.has(language) ? language : 'auto';
    if (this.proc && !this.proc.killed && this.language === lang && this.ready) return this.ready;
    this.stop();
    const info = this.info();
    if (!info.ready) return Promise.resolve(false);
    const threads = Math.max(2, Math.min(6, (os.cpus() || []).length || 4));
    const args = [
      '--model', info.model,
      '--tokens', info.tokens,
      '--language', lang,
      '--threads', String(threads),
    ];
    let proc;
    try {
      proc = spawn(info.server, args, {
        cwd: path.dirname(info.server),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      return Promise.resolve(false);
    }
    this.proc = proc;
    this.language = lang;
    this.stderr = '';
    this.pending.clear();
    proc.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + String(chunk)).slice(-800);
    });
    proc.once('error', () => this.reset(proc));
    proc.once('exit', () => this.reset(proc));
    const rl = readline.createInterface({ input: proc.stdout });
    this.ready = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      rl.on('line', (line) => {
        let message = null;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (message.ready === true) {
          finish(true);
          return;
        }
        if (message.ready === false) {
          finish(false);
          return;
        }
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(String(message.error)));
        else request.resolve(message);
      });
      proc.once('exit', () => finish(false));
      proc.once('error', () => finish(false));
      const timer = setTimeout(() => finish(false), 20000);
      timer.unref?.();
    });
    return this.ready;
  }

  reset(proc) {
    if (this.proc !== proc) return;
    this.proc = null;
    this.language = '';
    this.ready = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`SenseVoice 服务退出${this.stderr ? `：${this.stderr.slice(-160)}` : ''}`));
    }
    this.pending.clear();
  }

  async recognize(wav, language, timeoutMs = 15000) {
    const ready = await this.ensure(language);
    if (!ready || !this.proc) throw new Error('SenseVoice 未就绪');
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('SenseVoice 识别超时'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(`${JSON.stringify({ id, wav })}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    this.language = '';
    this.ready = null;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('SenseVoice 已停止'));
    }
    this.pending.clear();
    if (!proc) return;
    try { proc.stdin.write('{"cmd":"quit"}\n'); } catch {}
    try { proc.kill(); } catch {}
  }
}

module.exports = { SenseVoiceService, SENSE_LANGS };
