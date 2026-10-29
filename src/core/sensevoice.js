const fs = require('fs');
const os = require('os');
const path = require('path');

const SENSE_LANGS = new Set(['zh', 'en', 'ja', 'ko', 'yue']);

function normalizeLanguage(value) {
  const lang = String(value || '').toLowerCase();
  if (lang.startsWith('zh')) return 'zh';
  if (lang.startsWith('en')) return 'en';
  if (lang.startsWith('ja')) return 'ja';
  if (lang.startsWith('ko')) return 'ko';
  if (lang.startsWith('yue') || lang.startsWith('cantonese')) return 'yue';
  return SENSE_LANGS.has(lang) ? lang : 'auto';
}

function readWav(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (data.length < 44) throw new Error('音频数据不完整');
  if (data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是有效的 WAV 音频');
  }
  let format = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bits = 16;
  let pcm = null;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(data.length, start + size);
    if (id === 'fmt ' && size >= 16) {
      format = data.readUInt16LE(start);
      channels = data.readUInt16LE(start + 2) || 1;
      sampleRate = data.readUInt32LE(start + 4) || 16000;
      bits = data.readUInt16LE(start + 14) || 16;
      if (format === 0xfffe && size >= 26) format = data.readUInt16LE(start + 24);
    } else if (id === 'data') {
      pcm = data.subarray(start, end);
    }
    offset = start + size + (size % 2);
  }
  if (!pcm || !pcm.length) throw new Error('WAV 中没有音频数据');
  const bytes = Math.max(1, Math.ceil(bits / 8));
  const frames = Math.floor(pcm.length / (bytes * channels));
  const samples = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      const at = (frame * channels + channel) * bytes;
      let value = 0;
      if (format === 3 && bits === 32) {
        value = pcm.readFloatLE(at);
      } else if (bits === 8) {
        value = (pcm[at] - 128) / 128;
      } else if (bits === 16) {
        value = pcm.readInt16LE(at) / 32768;
      } else if (bits === 24) {
        value = pcm.readIntLE(at, 3) / 8388608;
      } else if (bits === 32) {
        value = pcm.readInt32LE(at) / 2147483648;
      }
      sum += value;
    }
    samples[frame] = sum / channels;
  }
  return { samples, sampleRate };
}

function cleanText(value) {
  return String(value || '')
    .replace(/<\|[^|]*\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

class SenseVoiceService {
  constructor({ rootDir }) {
    this.rootDir = rootDir;
    this.base = path.join(rootDir, 'vendor', 'sensevoice');
    this.nodeEntry = path.join(this.base, 'node', 'sherpa-onnx.js');
    this.nativeDir = path.join(this.base, 'node', 'node_modules', 'sherpa-onnx-win-x64');
    this.model = path.join(this.base, 'models', 'model.int8.onnx');
    this.tokens = path.join(this.base, 'models', 'tokens.txt');
    this.sherpa = null;
    this.loadError = '';
    this.recognizers = new Map();
    this.starting = new Map();
  }

  info() {
    const result = {
      ready: false,
      name: 'SenseVoice int8',
      entry: this.nodeEntry,
      native: path.join(this.nativeDir, 'sherpa-onnx.node'),
      runtime: path.join(this.nativeDir, 'onnxruntime.dll'),
      model: this.model,
      tokens: this.tokens,
      reason: '',
    };
    try {
      if (!fs.existsSync(this.nodeEntry)) throw new Error('缺少 SenseVoice 运行文件');
      if (!fs.existsSync(result.native) || !fs.existsSync(result.runtime)) {
        throw new Error('缺少 SenseVoice 原生运行时');
      }
      if (!fs.existsSync(this.model) || fs.statSync(this.model).size < 100 * 1024 * 1024) {
        throw new Error('缺少 SenseVoice 模型');
      }
      if (!fs.existsSync(this.tokens) || fs.statSync(this.tokens).size < 100 * 1024) {
        throw new Error('缺少 SenseVoice tokens');
      }
      result.ready = true;
    } catch (err) {
      result.reason = String(err.message || 'SenseVoice 不可用');
    }
    return result;
  }

  load() {
    if (this.sherpa) return this.sherpa;
    if (this.loadError) throw new Error(this.loadError);
    const info = this.info();
    if (!info.ready) {
      this.loadError = info.reason;
      throw new Error(this.loadError);
    }
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      this.sherpa = require(this.nodeEntry);
      return this.sherpa;
    } catch (err) {
      this.loadError = `SenseVoice 运行时加载失败：${String(err.message || err).slice(0, 160)}`;
      throw new Error(this.loadError);
    }
  }

  ensure(language = 'zh') {
    const lang = normalizeLanguage(language);
    if (this.recognizers.has(lang)) return Promise.resolve(true);
    if (this.starting.has(lang)) return this.starting.get(lang).then(() => true, () => false);
    const task = (async () => {
      const sherpa = this.load();
      const threads = Math.max(2, Math.min(6, (os.cpus() || []).length || 4));
      const recognizer = await sherpa.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          senseVoice: {
            model: this.model,
            language: lang,
            useInverseTextNormalization: 1,
          },
          tokens: this.tokens,
          numThreads: threads,
          provider: 'cpu',
          debug: 0,
        },
      });
      this.recognizers.set(lang, recognizer);
      return recognizer;
    })();
    this.starting.set(lang, task);
    task.then(
      () => this.starting.delete(lang),
      () => this.starting.delete(lang),
    );
    return task.then(() => true, () => false);
  }

  async recognize(wav, language, timeoutMs = 15000) {
    const lang = normalizeLanguage(language);
    const info = this.info();
    if (!info.ready) throw new Error(info.reason || 'SenseVoice 未就绪');
    const { samples, sampleRate } = readWav(wav);
    const ready = await this.ensure(lang);
    if (!ready) throw new Error(this.loadError || 'SenseVoice 未就绪');
    const recognizer = this.recognizers.get(lang);
    if (!recognizer) throw new Error('SenseVoice 未就绪');
    const stream = recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    let timer = null;
    try {
      const result = await Promise.race([
        recognizer.decodeAsync(stream),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(new Error('SenseVoice 识别超时')), timeoutMs);
        }),
      ]);
      return {
        text: cleanText(result.text),
        language: lang,
        emotion: cleanText(result.emotion),
        event: cleanText(result.event),
        tokens: Array.isArray(result.tokens) ? result.tokens : [],
        timestamps: Array.isArray(result.timestamps) ? result.timestamps : [],
        durations: Array.isArray(result.durations) ? result.durations : [],
      };
    } finally {
      clearTimeout(timer);
    }
  }

  stop() {
    this.recognizers.clear();
    this.starting.clear();
  }
}

module.exports = { SenseVoiceService, SENSE_LANGS, normalizeLanguage, readWav };
