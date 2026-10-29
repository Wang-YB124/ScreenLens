const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const { BrowserWindow, screen, app } = require('electron');
const { createRealtimeWindow, sendRealtimeInit } = require('../windows/realtimeWindow');
const { translateAI, translateFree, LANG_NAMES } = require('./translate');
const { providerLabel } = require('./llm');
const { startTiming, markTiming, finishTiming } = require('./timing');
const { getOutputDeviceState } = require('./audio-device');
const { AUDIO_MODES } = require('./settings');
const { SenseVoiceService, SENSE_LANGS } = require('./sensevoice');
const T2S = require('./t2s.json');

function findFreePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(0));
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeout = 8000) {
  return new Promise((resolve) => {
    const end = Date.now() + timeout;
    const attempt = () => {
      if (Date.now() > end) {
        resolve(false);
        return;
      }
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        setTimeout(attempt, 150);
      });
      socket.setTimeout(600, () => {
        socket.destroy();
        setTimeout(attempt, 150);
      });
    };
    attempt();
  });
}


const HALLUCINATION_PATTERNS = [
  /^(谢谢观看|感谢观看|请不吝点赞|请订阅|订阅频道|字幕\s*(?:by|由|组|制作|提供|翻译|校对|整理|上传|[:：])|訂閱|订阅|小铃铛|明镜与点点)/i,
  /^(thanks?\s+for\s+watching|thank\s+you\s+for\s+watching|please\s+subscribe|amara\.org|subtitles\s+by)/i,
  /^[\(\[（【][\s\S]*[\)\]）】]$/,
  /^(\(|\[)?\s*(buzz|music|applause|laughter|silence|blank_audio|inaudible|no speech|the end)\s*(\)|\])?$/i,
  /^\((x|×)\s*\d+\)$/i,
];


const AUDIO_LANG_META = {
  zh: { whisper: 'zh', source: 'zh-CN', script: 'han' },
  en: { whisper: 'en', source: 'en', script: 'latin' },
  ja: { whisper: 'ja', source: 'ja', script: 'japanese' },
  ko: { whisper: 'ko', source: 'ko', script: 'korean' },
  ru: { whisper: 'ru', source: 'ru', script: 'cyrillic' },
  fr: { whisper: 'fr', source: 'fr', script: 'latin' },
  de: { whisper: 'de', source: 'de', script: 'latin' },
  es: { whisper: 'es', source: 'es', script: 'latin' },
  pt: { whisper: 'pt', source: 'pt', script: 'latin' },
  it: { whisper: 'it', source: 'it', script: 'latin' },
};

function audioLanguage(value) {
  return AUDIO_LANG_META[value] ? value : 'zh';
}

function sourceLabel(source) {
  return LANG_NAMES[source] || source;
}

const WHISPER_LANG_NAMES = {
  chinese: 'zh',
  english: 'en',
  japanese: 'ja',
  korean: 'ko',
  russian: 'ru',
  french: 'fr',
  german: 'de',
  spanish: 'es',
  portuguese: 'pt',
  italian: 'it',
};

function normalizeDetectedLanguage(code, text) {
  const raw = String(code || '').toLowerCase();
  if (AUDIO_LANG_META[raw]) return raw;
  if (WHISPER_LANG_NAMES[raw]) return WHISPER_LANG_NAMES[raw];
  if (raw.startsWith('zh')) return 'zh';
  const sample = String(text || '');
  if (/[Ѐ-ӿ]/.test(sample)) return 'ru';
  if (/[぀-ヿ]/.test(sample)) return 'ja';
  if (/[가-힯]/.test(sample)) return 'ko';
  if (/[㐀-鿿]/.test(sample)) return 'zh';
  if (/[A-Za-z]/.test(sample)) return 'en';
  return 'zh';
}

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

function isCjkText(text) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(text);
}

function speechChars(text, lang) {
  let value = String(text || '');
  if (lang === 'zh') value = toSimplified(value);
  const chars = [];
  const map = [];
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (/[\p{L}\p{N}]/u.test(ch)) {
      chars.push(ch.toLowerCase());
      map.push(i);
    }
  }
  return { text: value, norm: chars.join(''), map };
}

function longestCommonSubstring(a, b) {
  let best = { len: 0, ai: 0, bi: 0 };
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let size = 0;
      while (i + size < a.length && j + size < b.length && a[i + size] === b[j + size]) size += 1;
      if (size > best.len) best = { len: size, ai: i, bi: j };
    }
  }
  return best;
}

function trimOverlap(previous, next, lang = 'zh') {
  if (!previous || !next) return next;
  if (previous === next) return '';
  const isCjk = isCjkText(next);
  const floor = isCjk ? 2 : 6;
  const prev = speechChars(previous, lang).norm.slice(-28);
  const cur = speechChars(next, lang);
  if (!prev || !cur.norm) return next;
  const head = cur.norm.slice(0, 32);
  let best = { len: 0, end: 0 };
  for (let start = 0; start < Math.min(3, head.length); start += 1) {
    const found = longestCommonSubstring(prev, head.slice(start));
    if (found.len < floor) continue;
    const end = start + found.bi + found.len;
    if (end > best.end || (end === best.end && found.len > best.len)) best = { len: found.len, end };
  }
  if (best.len < floor) return next;
  if (best.end >= cur.norm.length) return '';
  let cut = best.end < cur.map.length ? cur.map[best.end] : next.length;
  if (!isCjk) {
    while (cut > 0 && /[\p{L}\p{N}]/u.test(next[cut - 1]) && /[\p{L}\p{N}]/u.test(next[cut] || ' ')) cut -= 1;
  }
  return tidySpeech(next.slice(cut));
}

function silenceWav(ms = 400, rate = 48000) {
  const count = Math.max(1, Math.round((rate * ms) / 1000));
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + count * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(count * 2, 40);
  return buffer;
}

function wavStats(buffer) {
  try {
    if (!buffer || buffer.length < 44) return null;
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const channels = view.getUint16(22, true) || 1;
    const sampleRate = view.getUint32(24, true) || 0;
    let offset = 12;
    let dataOffset = 44;
    let dataSize = buffer.length - 44;
    while (offset + 8 <= buffer.length) {
      const id = String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
      );
      const size = view.getUint32(offset + 4, true);
      if (id === 'data') {
        dataOffset = offset + 8;
        dataSize = Math.min(size, buffer.length - dataOffset);
        break;
      }
      offset += 8 + size + (size % 2);
    }
    let sum = 0;
    let count = 0;
    let active = 0;
    const step = 2 * channels;
    for (let i = dataOffset; i + 1 < dataOffset + dataSize; i += step) {
      const value = view.getInt16(i, true) / 32768;
      sum += value * value;
      if (Math.abs(value) >= 0.012) active += 1;
      count += 1;
    }
    return {
      rms: Math.sqrt(sum / Math.max(1, count)),
      activeRatio: active / Math.max(1, count),
      sampleRate,
      channels,
    };
  } catch {
    return null;
  }
}

function looksDegenerate(text) {
  const compact = String(text || '').replace(/[^\p{L}\p{N}]+/gu, '');
  if (compact.length < 8) return false;
  if (/(.)\1{5,}/u.test(compact)) return true;
  if (/(.{1,6})\1{3,}/u.test(compact)) return true;
  return false;
}

function looksLikeHallucination(text, language = 'zh') {
  if (!text) return true;
  if (HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text))) return true;
  if (looksDegenerate(text)) return true;
  const spoken = text.replace(/[^\p{L}\p{N}]+/gu, '');
  if (spoken.length < 1) return true;
  const hasHan = /[㐀-鿿]/.test(text);
  const hasKana = /[぀-ヿ]/.test(text);
  const hasHangul = /[가-힯]/.test(text);
  const hasLatin = /[A-Za-z]/.test(text);
  const hasCyrillic = /[Ѐ-ӿ]/.test(text);
  const script = (AUDIO_LANG_META[audioLanguage(language)] || AUDIO_LANG_META.zh).script;
  if (script === 'han') return !hasHan && (hasLatin || hasKana || hasHangul);
  if (script === 'japanese') return !hasHan && !hasKana && (hasLatin || hasHangul);
  if (script === 'korean') return !hasHangul && (hasLatin || hasHan);
  if (script === 'cyrillic') return !hasCyrillic && (hasLatin || hasHan);
  return !hasLatin && (hasHan || hasKana || hasHangul || hasCyrillic);
}

class AudioController {
  constructor({ settings, tempDir, rootDir, onStateChange, notify, minimizeHome, restoreHome }) {
    this.settings = settings;
    this.tempDir = tempDir;
    this.rootDir = rootDir;
    this.sense = new SenseVoiceService({ rootDir });
    this.onStateChange = onStateChange || (() => {});
    this.notify = notify || (() => {});
    this.minimizeHome = minimizeHome || (async () => false);
    this.restoreHome = restoreHome || (() => {});
    this.homeMinimized = false;
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
    this.lastExplain = null;
    this.lastErrorAt = 0;
    this.fallbackNotified = false;
    this.startCount = 0;
    this.timingId = '';
    this.spanTimingId = '';
    this.firstOriginalSent = false;
    this.firstSubtitleSent = false;
    this.firstTextSent = false;
    this.firstChunkAt = 0;
    this.firstChunkStats = null;
    this.detectedLang = '';
    this.languageSetting = this.settings.get().audio.language;
    this.modelSetting = this.settings.get().audio.model;
    this.speedSetting = this.settings.get().audio.speed;
    this.server = null;
    this.serverPort = 0;
    this.serverStarting = null;
    this.serverWarmed = false;
    this.recordDir = this.resolveRecordDir();
    this.recordFile = '';
    this.recordSegments = [];
    this.recordStartedAt = 0;
    this.recordMeta = null;
    this.recordTimer = null;
    this.recordFinished = false;
    this.lastRecordPath = '';
    this.recordErrorNotified = false;
    this.silentChunks = 0;
    this.silenceNoticeKey = '';
    this.silenceQuerying = false;
    this.listening = false;
    this.captureInfo = null;
    this.whisperStarted = false;
    this.whisperDone = false;
  }

  isActive() {
    return this.active;
  }

  modelInfo() {
    const base = path.join(this.rootDir, 'vendor', 'whisper');
    const runtime = path.join(base, 'runtime', 'whisper-cli.exe');
    const server = path.join(base, 'runtime', 'whisper-server.exe');
    const models = path.join(base, 'models');
    const candidates = [
      { key: 'base', name: 'Whisper base (q5_1)', file: 'ggml-base-q5_1.bin', min: 40 * 1024 * 1024 },
      { key: 'small', name: 'Whisper small (q5_1)', file: 'ggml-small-q5_1.bin', min: 150 * 1024 * 1024 },
    ];
    const desired = this.settings.get().audio.model === 'small' ? 'small' : 'base';
    const ordered = [
      ...candidates.filter((item) => item.key === desired),
      ...candidates.filter((item) => item.key !== desired),
    ];
    if (fs.existsSync(runtime)) {
      for (const candidate of ordered) {
        const file = path.join(models, candidate.file);
        try {
          const stat = fs.statSync(file);
          if (stat.size >= candidate.min) {
            return {
              ready: true,
              runtime,
              server: fs.existsSync(server) ? server : '',
              model: file,
              name: candidate.name,
              key: candidate.key,
              reason: '',
            };
          }
        } catch {}
      }
    }
    return {
      ready: false,
      runtime,
      server: '',
      model: '',
      name: 'Whisper',
      key: '',
      reason: '未找到本地 Whisper 运行文件或模型，请先运行 scripts/fetch-whisper.ps1',
    };
  }

  senseVoiceInfo() {
    return this.sense ? this.sense.info() : {
      ready: false,
      name: 'SenseVoice int8',
      reason: 'SenseVoice 服务未初始化',
    };
  }

  ensureSense(language) {
    return this.sense ? this.sense.ensure(language) : Promise.resolve(false);
  }

  modeInfo() {
    const key = this.settings.get().audio.speed;
    const preset = AUDIO_MODES[key] || AUDIO_MODES.fast;
    return {
      key: preset.key,
      label: preset.label,
      hint: preset.hint,
      model: preset.model,
      firstChunkMs: preset.firstChunkMs,
      chunkMs: preset.chunkMs,
      overlapMs: preset.overlapMs,
    };
  }

  async ensureServer() {
    if (this.server && this.serverPort) return this.serverPort;
    if (this.serverStarting) return this.serverStarting;
    const info = this.modelInfo();
    if (!info.ready || !info.server) return 0;
    const port = await findFreePort();
    if (!port) return 0;
    const threads = Math.max(4, Math.min(16, (os.cpus() || []).length || 4));
    const args = [
      '-m', info.model,
      '-t', String(threads),
      '--host', '127.0.0.1',
      '--port', String(port),
      '-sns',
      '-bo', '1',
      '-bs', '1',
    ];
    this.serverStarting = new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(info.server, args, {
          cwd: path.dirname(info.server),
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
      } catch {
        resolve(0);
        return;
      }
      this.server = proc;
      let stderr = '';
      try {
        proc.stderr.on('data', (chunk) => {
          stderr = (stderr + String(chunk)).slice(-800);
        });
      } catch {}
      this.serverError = '';
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      proc.once('error', () => {
        if (this.server === proc) this.server = null;
        done(0);
      });
      proc.once('exit', (code) => {
        if (this.server === proc) this.server = null;
        this.serverPort = 0;
        this.serverError = stderr.trim().slice(0, 300);
        markTiming(this.spanTimingId, 'server-exit', { code, message: this.serverError.slice(0, 160) });
        done(0);
      });
      waitForPort(port, 15000).then((ok) => {
        if (ok && this.active && !this.server?.killed) {
          this.serverPort = port;
          markTiming(this.timingId, 'server-ready', { port, model: info.key });
          done(port);
        } else {
          try { proc.kill(); } catch {}
          done(0);
        }
      });
    }).finally(() => {
      this.serverStarting = null;
    });
    return this.serverStarting;
  }

  stopServer() {
    const proc = this.server;
    this.server = null;
    this.serverPort = 0;
    this.serverStarting = null;
    if (proc) {
      try { proc.kill(); } catch {}
    }
  }

  serverRecognize(audio, options = {}) {
    return this.ensureServer().then((port) => {
      if (!port) {
        throw new Error(this.serverError
          ? `Whisper server 未启动：${this.serverError}`
          : 'Whisper server unavailable');
      }
      const data = Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
      const boundary = `----screenlens${Date.now().toString(16)}`;
      const fields = {
        response_format: options.responseFormat || 'json',
        language: options.language || 'auto',
        temperature: '0',
        temperature_inc: String(options.temperatureInc ?? 0),
      };
      if (options.noLanguageProbabilities) fields.no_language_probabilities = 'true';
      const chunks = [];
      for (const [key, value] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`));
      }
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="chunk.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
      chunks.push(data);
      chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const body = Buffer.concat(chunks);
      return new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port,
          path: '/inference',
          method: 'POST',
          timeout: options.timeoutMs || 20000,
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': body.length,
          },
        }, (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => {
            if (res.statusCode !== 200) {
              reject(new Error(`Whisper server ${res.statusCode}`));
              return;
            }
            try {
              const parsed = JSON.parse(text);
              resolve({
                text: String(parsed.text || '').trim(),
                language: String(parsed.detected_language || parsed.language || ''),
              });
            } catch (err) {
              reject(err);
            }
          });
        });
        req.on('timeout', () => req.destroy(new Error('Whisper server timeout')));
        req.on('error', reject);
        req.end(body);
      });
    });
  }

  async warmServer() {
    if (this.serverWarmed) return;
    this.serverWarmed = true;
    const settings = this.settings.get();
    const language = settings.audio.language === 'auto'
      ? 'zh'
      : (AUDIO_LANG_META[audioLanguage(settings.audio.language)] || AUDIO_LANG_META.zh).whisper;
    try {
      const started = Date.now();
      await this.serverRecognize(silenceWav(400), { language, timeoutMs: 8000 });
      markTiming(this.timingId, 'server-warm', { ms: Date.now() - started });
    } catch {}
  }

  dispose() {
    this.stopServer();
    if (this.sense) this.sense.stop();
    if (this.proc) {
      try { this.proc.kill(); } catch {}
      this.proc = null;
    }
  }

  defaultRecordDir() {
    return path.join(app.getPath('userData'), 'audio-records');
  }

  resolveRecordDir() {
    const custom = String(this.settings.get().audio.recordDir || '').trim();
    return custom || this.defaultRecordDir();
  }

  latestRecord(dir) {
    try {
      const files = fs.readdirSync(dir)
        .filter((name) => name.startsWith('音频记录-') && name.endsWith('.txt'))
        .sort();
      return files.length ? path.join(dir, files[files.length - 1]) : '';
    } catch {
      return '';
    }
  }

  beginRecord({ source, settings }) {
    const now = Date.now();
    const date = new Date(now);
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const realtime = settings.realtime || {};
    const target = realtime.targetLang && realtime.targetLang !== 'auto'
      ? realtime.targetLang
      : settings.targetLang;
    const language = settings.audio.language;
    const meta = AUDIO_LANG_META[audioLanguage(language)] || AUDIO_LANG_META.zh;
    this.recordDir = this.resolveRecordDir();
    this.recordFile = path.join(this.recordDir, `音频记录-${stamp}.txt`);
    this.recordSegments = [];
    this.recordStartedAt = now;
    this.recordTimer = null;
    this.recordFinished = false;
    this.recordErrorNotified = false;
    const preset = AUDIO_MODES[this.settings.get().audio.speed] || AUDIO_MODES.fast;
    const whisperInfo = this.modelInfo();
    const senseInfo = this.senseVoiceInfo();
    const usesSense = language === 'auto' || SENSE_LANGS.has(language);
    const engine = usesSense && senseInfo.ready
      ? (whisperInfo.ready ? 'SenseVoice + Whisper（混合）' : 'SenseVoice int8')
      : (whisperInfo.ready ? whisperInfo.name : 'SenseVoice int8');
    this.recordMeta = {
      startedAt: now,
      source: source === 'microphone' ? '麦克风' : '系统声音',
      language: language === 'auto' ? '自动检测' : sourceLabel(meta.source),
      target: LANG_NAMES[target] || target || '',
      model: engine,
      mode: preset.label,
    };
  }

  recordSegment({ original, translated, direction }) {
    if (!this.recordStartedAt) return;
    const sourceText = String(original || '').trim();
    const targetText = String(translated || '').trim();
    if (!sourceText && !targetText) return;
    const last = this.recordSegments[this.recordSegments.length - 1];
    if (last) {
      if (sourceText && last.original === sourceText) {
        if (targetText) last.translated = targetText;
        if (direction) last.direction = direction;
        this.scheduleRecordSave();
        return;
      }
      if (!sourceText && last.same && last.original === targetText) return;
      if (!sourceText && !last.original && last.translated === targetText) return;
    }
    this.recordSegments.push({
      at: Date.now(),
      original: sourceText || targetText,
      translated: sourceText ? targetText : '',
      direction: direction || '',
      same: !sourceText,
    });
    this.scheduleRecordSave();
  }

  scheduleRecordSave() {
    if (this.recordTimer || this.recordFinished) return;
    this.recordTimer = setTimeout(() => {
      this.recordTimer = null;
      this.writeRecord();
    }, 900);
  }

  formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  writeRecord() {
    if (!this.recordStartedAt || !this.recordSegments.length) return '';
    const meta = this.recordMeta || {};
    const date = new Date(meta.startedAt || this.recordStartedAt);
    const pad = (value) => String(value).padStart(2, '0');
    const heading = [
      'ScreenLens 音频字幕记录',
      `开始时间：${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
      `音频来源：${meta.source || ''}`,
      `识别语言：${meta.language || ''}`,
      `译文语言：${meta.target || ''}`,
      `识别模型：${meta.model || ''}`,
      `识别模式：${meta.mode || ''}`,
      `记录条数：${this.recordSegments.length}`,
      '----------------------------------------',
    ];
    const lines = [];
    for (const segment of this.recordSegments) {
      const at = this.formatElapsed(segment.at - this.recordStartedAt);
      lines.push(`[${at}] 原文：${segment.original}`);
      if (segment.translated) lines.push(`        译文：${segment.translated}`);
      else if (segment.same) lines.push('        译文：（同原文）');
    }
    const content = `\uFEFF${heading.join('\n')}\n${lines.join('\n')}\n`;
    try {
      fs.mkdirSync(this.recordDir, { recursive: true });
      fs.writeFileSync(this.recordFile, content, 'utf8');
      this.lastRecordPath = this.recordFile;
      markTiming(this.timingId, 'record-saved', { chars: content.length, segments: this.recordSegments.length });
      return this.recordFile;
    } catch (err) {
      markTiming(this.timingId, 'record-error', { message: String(err.message || '').slice(0, 120) });
      if (!this.recordErrorNotified) {
        this.recordErrorNotified = true;
        this.notify('音频记录保存失败', `无法写入 ${this.recordDir}；请在 设置 → 音频字幕 更换记录位置。`);
      }
      return '';
    }
  }

  finishRecord() {
    if (this.recordTimer) {
      clearTimeout(this.recordTimer);
      this.recordTimer = null;
    }
    if (this.recordFinished) return this.lastRecordPath;
    this.recordFinished = true;
    if (!this.recordSegments.length) return '';
    return this.writeRecord();
  }

  getExplainContext() {
    if (!this.active || !this.lastExplain?.text) return null;
    return { ...this.lastExplain };
  }

  recordInfo() {
    const dir = this.active && this.recordDir ? this.recordDir : this.resolveRecordDir();
    let last = this.lastRecordPath;
    if (!last || path.dirname(last) !== dir || !fs.existsSync(last)) {
      last = this.latestRecord(dir);
    }
    return {
      dir,
      lastRecord: last || '',
      defaultDir: this.defaultRecordDir(),
      custom: Boolean(String(this.settings.get().audio.recordDir || '').trim()),
    };
  }

  send(payload) {
    if (payload?.status === 'done' && payload.translated && this.lastExplain
      && (!payload.original || payload.original === this.lastExplain.text)) {
      this.lastExplain.translation = payload.translated;
    }
    if (payload?.status === 'loading' && payload.original) {
      this.recordSegment({ original: payload.original, translated: '', direction: payload.direction });
    } else if (payload?.status === 'done' && (payload.original || payload.translated)) {
      this.recordSegment({ original: payload.original || '', translated: payload.translated || '', direction: payload.direction });
    }
    if (!this.firstOriginalSent && payload?.original) {
      this.firstOriginalSent = true;
      markTiming(this.timingId, 'first-original', { chars: String(payload.original).length });
    }
    if (!this.firstSubtitleSent && payload?.translated) {
      this.firstSubtitleSent = true;
      markTiming(this.timingId, 'first-subtitle', { chars: String(payload.translated).length });
      finishTiming(this.timingId, { outcome: 'first-subtitle' });
    }
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('realtime:update', payload);
    }
  }

  refreshSettings() {
    const audio = this.settings.get().audio;
    if (audio.speed !== this.speedSetting) {
      this.speedSetting = audio.speed;
      this.serverWarmed = false;
    }
    if (audio.model !== this.modelSetting) {
      this.modelSetting = audio.model;
      this.stopServer();
    }
    const language = audio.language;
    if (language !== this.languageSetting) {
      this.languageSetting = language;
      this.detectedLang = '';
      this.prevRaw = '';
      this.sense.stop();
      if (this.active && SENSE_LANGS.has(language)) this.ensureSense(language).catch(() => {});
    }
    if (this.win && !this.win.isDestroyed()) {
      sendRealtimeInit(this.win, this.settings.get());
    }
  }

  async start(options = {}) {
    if (this.active) return { ok: true, active: true };
    const timingId = startTiming('audio', {
      source: options.source || 'unknown',
      clickedAt: options.clickedAt,
      round: ++this.startCount,
    });
    this.timingId = timingId;
    this.spanTimingId = startTiming('audio-span', {
      source: options.source || 'unknown',
      clickedAt: options.clickedAt,
      round: this.startCount,
    });
    this.firstOriginalSent = false;
    this.firstSubtitleSent = false;
    this.firstTextSent = false;
    this.firstChunkAt = 0;
    this.firstChunkStats = null;
    this.detectedLang = '';
    this.languageSetting = this.settings.get().audio.language;
    this.modelSetting = this.settings.get().audio.model;
    this.speedSetting = this.settings.get().audio.speed;
    this.server = null;
    this.serverPort = 0;
    this.serverStarting = null;
    this.serverWarmed = false;
    this.recordDir = this.resolveRecordDir();
    this.recordFile = '';
    this.recordSegments = [];
    this.recordStartedAt = 0;
    this.recordMeta = null;
    this.recordTimer = null;
    this.recordFinished = false;
    this.lastRecordPath = '';
    this.recordErrorNotified = false;
    this.silentChunks = 0;
    this.silenceNoticeKey = '';
    this.silenceQuerying = false;
    this.listening = false;
    this.captureInfo = null;
    this.whisperStarted = false;
    this.whisperDone = false;
    markTiming(timingId, 'begin-work');

    const info = this.modelInfo();
    const senseInfo = this.senseVoiceInfo();
    const configuredLanguage = this.settings.get().audio.language;
    const senseOnly = SENSE_LANGS.has(configuredLanguage) && senseInfo.ready;
    markTiming(timingId, 'model-check', {
      ready: info.ready || senseOnly,
      whisper: info.ready,
      sensevoice: senseInfo.ready,
    });
    if (!info.ready && !senseOnly) {
      const reason = info.reason || senseInfo.reason || '本地识别模型不可用';
      this.notify('音频字幕无法启动', reason);
      finishTiming(timingId, { outcome: 'model-unavailable' });
      return { ok: false, error: reason };
    }

    const settings = this.settings.get();
    const source = settings.audio.source === 'microphone' ? 'microphone' : 'system';
    const preset = AUDIO_MODES[settings.audio.speed] || AUDIO_MODES.fast;
    const chunkMs = preset.chunkMs;
    const overlapMs = preset.overlapMs;
    const firstChunkMs = settings.audio.language === 'auto'
      ? Math.max(preset.firstChunkMs, 1500)
      : preset.firstChunkMs;
    this.beginRecord({ source, settings });
    if (SENSE_LANGS.has(configuredLanguage)) this.ensureSense(configuredLanguage).catch(() => {});
    this.homeMinimized = await this.minimizeHome();
    markTiming(timingId, 'home-hidden', { hidden: this.homeMinimized });

    this.active = true;
    this.busy = false;
    this.queue = [];
    this.seq = 0;
    this.abort = null;
    this.gen += 1;
    this.cache.clear();
    this.prevRaw = '';
    this.uiText = '';
    this.lastExplain = null;
    this.lastErrorAt = 0;
    this.fallbackNotified = false;
    this.onStateChange({ audioActive: true });

    try {
      const display = screen.getPrimaryDisplay();
      markTiming(timingId, 'subtitle-create-start');
      this.win = createRealtimeWindow({
        rect: display.workArea,
        settings,
        scope: '音频',
      });
      markTiming(timingId, 'subtitle-created');
      setTimeout(() => {
        if (this.win && !this.win.isDestroyed()) {
          markTiming(timingId, 'subtitle-visible', { visible: this.win.isVisible() });
        }
      }, 80);
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
      markTiming(timingId, 'subtitle-waiting-sent');
      this.win.webContents.on('did-finish-load', () => {
        setTimeout(() => {
          if (this.active) this.send(waiting);
        }, 300);
      });

      markTiming(timingId, 'capture-window-create-start');
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
      markTiming(timingId, 'capture-window-created');
      this.capture.webContents.on('did-finish-load', () => {
        if (!this.active || !this.capture || this.capture.isDestroyed()) return;
        this.capture.webContents.send('audio:init', {
          source,
          chunkMs,
          overlapMs,
          firstChunkMs,
          speed: preset.key,
          sentence: Boolean(preset.sentence),
          timingId,
        });
        markTiming(timingId, 'capture-init-sent', {
          speed: preset.key,
          chunkMs,
          overlapMs,
          firstChunkMs,
          sentence: Boolean(preset.sentence),
        });
      });
      this.capture.loadFile(path.join(__dirname, '..', 'renderer', 'audio-capture', 'index.html'));
      if (configuredLanguage === 'auto' || !SENSE_LANGS.has(configuredLanguage) || !senseInfo.ready) {
        this.ensureServer()
          .then((port) => { if (port) this.warmServer(); })
          .catch(() => {});
      }
    } catch (err) {
      const message = String(err.message || '音频捕获初始化失败');
      markTiming(timingId, 'start-error', { message: message.slice(0, 160) });
      finishTiming(timingId, { outcome: 'error' });
      this.releaseHome();
      this.stop({ silent: true });
      setTimeout(() => this.notify('音频字幕启动失败', message), 150);
      return { ok: false, error: message };
    }

    const label = source === 'microphone' ? '麦克风' : '系统声音';
    const usesSense = configuredLanguage === 'auto' || SENSE_LANGS.has(configuredLanguage);
    const engineNote = usesSense && senseInfo.ready
      ? (info.ready ? '本地混合识别（SenseVoice / Whisper）' : '本地 SenseVoice 识别')
      : '本地 Whisper 识别';
    this.notify('音频字幕已开启', `正在聆听${label} · ${engineNote} · 点击按钮或字幕 × 停止`);
    return { ok: true, active: true };
  }

  async notifySilence() {
    if (this.silenceQuerying || !this.active || this.firstChunkAt) return;
    this.silenceQuerying = true;
    try {
      const source = this.captureInfo?.source
        || (this.settings.get().audio.source === 'microphone' ? 'microphone' : 'system');
      let key = '';
      let message = '';
      if (source === 'microphone') {
        key = 'microphone-silence';
        message = '正在聆听麦克风，但没有检测到声音；请检查麦克风是否被静音或被其他程序占用。';
      } else {
        const device = await getOutputDeviceState();
        markTiming(this.timingId, 'device-query', {
          ok: Boolean(device?.ok),
          muted: device?.muted,
          anyMuted: device?.anyMuted,
          volume: device?.volume,
          anyVolumeZero: device?.anyVolumeZero,
          deviceName: device?.deviceName,
          endpointId: device?.endpointId,
          error: device?.error,
        });
        if (!device || !device.ok) {
          key = 'no-device';
          message = '没有找到可用的系统输出设备，请检查扬声器/耳机是否连接。';
        } else if (device.anyMuted || device.anyVolumeZero || device.muted || Number(device.volume) < 0.01) {
          key = 'muted';
          message = '系统输出已静音或音量为 0，请取消静音/调高音量后再试。';
        } else {
          key = 'no-sound';
          message = '正在聆听系统声音，但当前没有检测到播放声音；请播放音频或检查输出设备。';
        }
      }
      if (key !== this.silenceNoticeKey) {
        this.silenceNoticeKey = key;
        this.send({
          status: 'waiting',
          original: this.uiText,
          translated: '',
          message,
        });
        markTiming(this.timingId, 'silence-notice', { key, message });
      }
    } finally {
      this.silenceQuerying = false;
    }
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
    if (!this.firstChunkAt) {
      this.firstChunkAt = Date.now();
      this.firstChunkStats = wavStats(data);
      this.silentChunks = 0;
      this.silenceNoticeKey = '';
      markTiming(this.timingId, 'first-chunk', {
        bytes: data.length,
        ...(this.firstChunkStats || {}),
      });
      this.send({
        status: 'waiting',
        original: this.uiText,
        translated: '',
        message: '正在识别语音…',
      });
    }
    this.seq += 1;
    const stats = wavStats(data);
    markTiming(this.spanTimingId, 'chunk', {
      bytes: data.length,
      seq: this.seq,
      queue: this.queue.length + 1,
      rms: stats ? stats.rms : null,
      activeRatio: stats ? stats.activeRatio : null,
    });
    this.queue.push({ data, at: Date.now() });
    while (this.queue.length > 4) this.queue.shift();
    this.pump();
  }

  async onCaptureStatus(payload) {
    if (!this.active || !payload) return;
    if (payload.status === 'listening') {
      this.listening = true;
      this.captureInfo = {
        source: payload.source,
        sampleRate: payload.sampleRate,
        trackLabel: payload.trackLabel,
        channelCount: payload.channelCount,
        deviceId: payload.deviceId,
      };
      markTiming(this.timingId, 'listening', {
        captureSource: this.captureInfo.source,
        sampleRate: this.captureInfo.sampleRate,
        trackLabel: this.captureInfo.trackLabel,
        channelCount: this.captureInfo.channelCount,
        deviceId: this.captureInfo.deviceId,
      });
      this.silenceNoticeKey = '';
      if (this.silentChunks > 0) {
        this.send({
          status: 'waiting',
          original: this.uiText,
          translated: '',
          message: payload.source === 'microphone' ? '正在聆听麦克风…' : '正在聆听系统声音…',
        });
      }
      return;
    }
    if (payload.status === 'device-change') {
      this.listening = false;
      this.silenceNoticeKey = '';
      markTiming(this.timingId, 'device-change', { message: payload.message });
      this.send({
        status: 'waiting',
        original: this.uiText,
        translated: '',
        message: payload.message || '输出设备已切换，正在重新连接…',
      });
      return;
    }
    if (payload.status === 'silence') {
      this.silentChunks += 1;
      markTiming(this.spanTimingId, 'silence', {
        rms: payload.rms,
        activeRatio: payload.activeRatio,
        count: this.silentChunks,
      });
      if (this.firstChunkAt) return;
      await this.notifySilence();
      return;
    }
    if (payload.status === 'error') {
      const message = String(payload.message || '请检查系统声音输出设备');
      markTiming(this.timingId, 'capture-error', {
        code: payload.code,
        message: message.slice(0, 160),
      });
      this.send({
        status: 'error',
        original: this.uiText,
        translated: '',
        message,
      });
      finishTiming(this.timingId, { outcome: 'capture-error' });
      this.releaseHome();
      this.stop({ silent: true });
      setTimeout(() => this.notify('音频字幕无法继续', message), 150);
    }
  }

  pump() {
    if (!this.active || this.busy || !this.queue.length) return;
    const item = this.queue.shift();
    this.busy = true;
    if (!this.whisperStarted) {
      this.whisperStarted = true;
      markTiming(this.timingId, 'whisper-start', { queue: this.queue.length + 1 });
    }
    this.recognize(item.data)
      .then(({ text, language }) => {
        if (!this.active) return;
        if (!this.whisperDone) {
          this.whisperDone = true;
          markTiming(this.timingId, 'whisper-done', { chars: String(text || '').length, language });
        }
        this.handleText(text, language);
      })
      .catch((err) => {
        if (!this.active) return;
        markTiming(this.timingId, 'whisper-error', {
          message: String(err.message || '').slice(0, 160),
        });
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
        this.busy = false;
        if (this.active) this.pump();
      });
  }

  async recognizeSense(data, language) {
    const result = await this.sense.recognize(data, language, 15000);
    return { text: String(result.text || '').trim(), language };
  }

  async recognize(data) {
    const settings = this.settings.get();
    const preset = AUDIO_MODES[settings.audio.speed] || AUDIO_MODES.fast;
    const configured = settings.audio.language;
    if (configured === 'auto' && !this.detectedLang) {
      const started = Date.now();
      try {
        const result = await this.serverRecognize(data, {
          language: 'auto',
          responseFormat: 'verbose_json',
          noLanguageProbabilities: true,
          temperatureInc: 0,
          timeoutMs: 15000,
        });
        if (result.text) {
          const detected = normalizeDetectedLanguage(result.language, result.text);
          this.detectedLang = detected;
          if (this.recordMeta) {
            const detectedMeta = AUDIO_LANG_META[detected] || AUDIO_LANG_META.zh;
            this.recordMeta.language = `自动检测（${sourceLabel(detectedMeta.source)}）`;
          }
          markTiming(this.timingId, 'language-detected', {
            detected,
            requested: 'auto',
            chars: result.text.length,
            ms: Date.now() - started,
          });
          if (SENSE_LANGS.has(detected)) this.ensureSense(detected).catch(() => {});
          markTiming(this.spanTimingId, 'recognize-server', {
            chars: result.text.length,
            language: detected,
            mode: preset.key,
            engine: 'whisper-auto',
            auto: true,
            ms: Date.now() - started,
          });
          return { text: result.text, language: detected };
        }
        markTiming(this.timingId, 'auto-empty', { ms: Date.now() - started });
      } catch (err) {
        markTiming(this.timingId, 'auto-server-fallback', {
          message: String(err.message || '').slice(0, 120),
        });
      }
      return this.recognizeCli(data);
    }
    const language = configured === 'auto' ? (this.detectedLang || 'auto') : audioLanguage(configured);
    const meta = AUDIO_LANG_META[audioLanguage(language)] || AUDIO_LANG_META.zh;
    const senseLang = SENSE_LANGS.has(audioLanguage(language)) ? audioLanguage(language) : '';
    if (senseLang && this.senseVoiceInfo().ready) {
      const started = Date.now();
      try {
        const result = await this.recognizeSense(data, senseLang);
        markTiming(this.spanTimingId, 'recognize-server', {
          chars: result.text.length,
          language: senseLang,
          mode: preset.key,
          engine: 'sensevoice',
          ms: Date.now() - started,
        });
        return { text: result.text, language: senseLang };
      } catch (err) {
        markTiming(this.timingId, 'sense-fallback', {
          language: senseLang,
          message: String(err.message || '').slice(0, 120),
        });
      }
    }
    try {
      const started = Date.now();
      const result = await this.serverRecognize(data, {
        language: meta.whisper,
        temperatureInc: preset.temperatureInc,
        timeoutMs: preset.key === 'accurate' ? 30000 : 15000,
      });
      markTiming(this.spanTimingId, 'recognize-server', {
        chars: result.text.length,
        language: meta.whisper,
        mode: preset.key,
        engine: 'whisper',
        ms: Date.now() - started,
      });
      return { text: result.text, language: meta.whisper };
    } catch (err) {
      markTiming(this.timingId, 'server-fallback', { message: String(err.message || '').slice(0, 120) });
    }
    return this.recognizeCli(data);
  }

  recognizeCli(data) {
    const info = this.modelInfo();
    if (!info.ready) throw new Error('本地 Whisper 模型不可用');
    const settings = this.settings.get();
    const preset = AUDIO_MODES[settings.audio.speed] || AUDIO_MODES.fast;
    const configured = settings.audio.language;
    const auto = configured === 'auto' && !this.detectedLang;
    const language = configured === 'auto'
      ? (this.detectedLang || 'auto')
      : audioLanguage(configured);
    const meta = AUDIO_LANG_META[audioLanguage(language)] || AUDIO_LANG_META.zh;
    const threads = Math.max(4, Math.min(16, (os.cpus() || []).length || 4));
    const file = path.join(this.tempDir, `asr-${process.pid}-${Date.now()}-${++this.seq}.wav`);
    try {
      fs.writeFileSync(file, Buffer.isBuffer(data) ? data : Buffer.from(data));
    } catch (err) {
      throw new Error(`音频写入失败：${String(err.message || '').slice(0, 80)}`);
    }
    const base = file.replace(/\.wav$/i, '');
    const output = `${base}-out`;
    const textPath = `${output}.txt`;
    const jsonPath = `${output}.json`;
    const cleanup = () => {
      try { fs.unlink(file, () => {}); } catch {}
      try { fs.unlink(textPath, () => {}); } catch {}
      try { fs.unlink(jsonPath, () => {}); } catch {}
    };
    const args = [
      '-m', info.model,
      '-f', file,
      '-l', auto ? 'auto' : meta.whisper,
      '-t', String(threads),
      '-nt',
      auto ? '-oj' : '-otxt',
      '-of', output,
      '-bo', '1',
      '-bs', '1',
      '-sns',
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
        cleanup();
        reject(err);
        return;
      }
      this.proc = proc;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch {}
        cleanup();
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
        cleanup();
        reject(err);
      });
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.proc === proc) this.proc = null;
        try {
          if (auto) {
            const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            const text = (Array.isArray(data.transcription) ? data.transcription : [])
              .map((item) => String(item?.text || ''))
              .join(' ')
              .trim();
            const detected = normalizeDetectedLanguage(data.result?.language, text);
            if (text) {
              this.detectedLang = detected;
              if (this.recordMeta) {
                const detectedMeta = AUDIO_LANG_META[detected] || AUDIO_LANG_META.zh;
                this.recordMeta.language = `自动检测（${sourceLabel(detectedMeta.source)}）`;
              }
            }
            markTiming(this.timingId, 'language-detected', {
              detected,
              requested: 'auto',
              chars: text.length,
              mode: preset.key,
            });
            resolve({ text, language: detected });
          } else {
            const text = fs.readFileSync(textPath, 'utf8').replace(/^﻿/, '').trim();
            resolve({ text, language: meta.whisper });
          }
        } catch {
          if (code !== 0) {
            reject(new Error(stderr.trim() || `Whisper 退出 ${code}`));
          } else {
            resolve({ text: '', language: auto ? (this.detectedLang || 'zh') : meta.whisper });
          }
        } finally {
          cleanup();
        }
      });
    });
  }

  handleText(raw, language) {
    const settings = this.settings.get();
    const lang = audioLanguage(language || (settings.audio.language === 'auto'
      ? (this.detectedLang || 'zh')
      : settings.audio.language));
    const meta = AUDIO_LANG_META[lang] || AUDIO_LANG_META.zh;
    const cleaned = lang === 'zh' ? toSimplified(tidySpeech(raw)) : tidySpeech(raw);
    if (!cleaned || looksLikeHallucination(cleaned, lang)) {
      markTiming(this.spanTimingId, 'text-skip', { reason: 'hallucination', chars: String(raw || '').length });
      return;
    }
    const display = trimOverlap(this.prevRaw, cleaned, lang);
    if (!display || looksLikeHallucination(display, lang)) {
      markTiming(this.spanTimingId, 'text-skip', { reason: 'overlap', chars: cleaned.length });
      return;
    }
    if (!speechChars(display, lang).norm) {
      markTiming(this.spanTimingId, 'text-skip', { reason: 'punct', chars: display.length });
      return;
    }
    if (display.length > (isCjkText(display) ? 80 : 240)) {
      markTiming(this.spanTimingId, 'text-skip', { reason: 'long', chars: display.length });
      return;
    }
    if (display === this.uiText && display.length < 12) {
      markTiming(this.spanTimingId, 'text-skip', { reason: 'repeat', chars: display.length });
      return;
    }
    this.prevRaw = cleaned;
    this.uiText = display;
    markTiming(this.spanTimingId, 'text', { chars: display.length, language: lang, mode: this.settings.get().audio.speed });
    if (!this.firstTextSent) {
      this.firstTextSent = true;
      markTiming(this.timingId, 'first-text', { chars: display.length, language: lang });
    }
    const sourceCode = meta.source;
    const realtime = settings.realtime || {};
    const target = realtime.targetLang && realtime.targetLang !== 'auto'
      ? realtime.targetLang
      : settings.targetLang;
    const same = sourceCode === target
      || (sourceCode === 'zh-CN' && String(target).startsWith('zh'));
    this.lastExplain = {
      text: display,
      translation: same ? display : '',
      sourceLang: sourceCode,
      targetLang: target,
      domain: 'general',
    };
    if (same) {
      this.send({
        status: 'done',
        original: '',
        translated: display,
        direction: sourceLabel(sourceCode),
        provider: '原文',
        domain: 'general',
      });
      return;
    }
    const directionLabel = `${sourceLabel(sourceCode)} → ${LANG_NAMES[target] || target}`;
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

  releaseHome() {
    if (!this.homeMinimized) return;
    this.homeMinimized = false;
    this.restoreHome();
  }

  stop({ silent = false } = {}) {
    if (!this.active && !this.win && !this.capture) {
      this.releaseHome();
      return;
    }
    if (!this.firstSubtitleSent) {
      markTiming(this.timingId, 'stop-before-subtitle');
      finishTiming(this.timingId, { outcome: 'stopped' });
    }
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
    if (this.sense) this.sense.stop();
    this.queue = [];
    if (this.capture && !this.capture.isDestroyed()) {
      try { this.capture.destroy(); } catch {}
    }
    this.capture = null;
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch {}
    }
    this.win = null;
    if (this.spanTimingId) {
      finishTiming(this.spanTimingId, { outcome: 'stopped' });
      this.spanTimingId = '';
    }
    this.releaseHome();
    this.onStateChange({ audioActive: false });
    if (!silent) {
      // The user stopped audio subtitles; no toast needed, the bar disappears.
    }
  }
}

module.exports = { AudioController, looksLikeHallucination, trimOverlap, tidySpeech };