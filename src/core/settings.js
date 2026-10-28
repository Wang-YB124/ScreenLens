const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { DOMAINS, normalizeDomain } = require('./domain');

const DEFAULTS = {
  targetLang: 'zh-CN',
  smartSwap: true,
  translateEngine: 'auto',
  contentDomain: 'auto',
  freeTranslation: true,
  explanationLanguage: 'zh-CN',
  provider: {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    temperature: 0.4,
  },
  vision: {
    enabled: false,
  },
  hotkeys: {
    select: 'Control+Alt+Q',
    realtime: 'Control+Alt+R',
  },
  realtime: {
    intervalMs: 900,
    fontSize: 20,
    opacity: 0.92,
    engine: 'auto',
    maxLines: 3,
    sourceLang: 'auto',
    targetLang: 'auto',
    boxWidth: 0,
    boxHeight: 0,
  },
  historyLimit: 60,
  launchAtLogin: false,
  historyPaused: false,
  onboarded: false,
  audio: {
    source: 'system',
    language: 'zh',
    model: 'base',
    chunkMs: 4000,
    overlapMs: 2000,
  },
};

const REALTIME_LANG_CODES = ['zh-CN', 'en', 'ja', 'ko', 'ru', 'fr', 'de', 'es', 'pt', 'it'];
const TARGET_LANGS = REALTIME_LANG_CODES.slice();

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [key, value] of Object.entries(patch || {})) {
    if (isObject(value) && isObject(out[key])) out[key] = merge(out[key], value);
    else if (value !== undefined) out[key] = value;
  }
  return out;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function sanitize(data) {
  const out = merge(DEFAULTS, data || {});
  out.targetLang = TARGET_LANGS.includes(out.targetLang) ? out.targetLang : DEFAULTS.targetLang;
  out.explanationLanguage = TARGET_LANGS.includes(out.explanationLanguage)
    ? out.explanationLanguage
    : out.targetLang;
  out.smartSwap = out.smartSwap !== false;
  out.translateEngine = ['auto', 'free', 'ai'].includes(out.translateEngine)
    ? out.translateEngine
    : 'auto';
  out.contentDomain = normalizeDomain(out.contentDomain, 'auto');
  out.freeTranslation = out.freeTranslation !== false;
  out.vision = { ...DEFAULTS.vision, ...(isObject(out.vision) ? out.vision : {}) };
  out.vision.enabled = Boolean(out.vision.enabled);
  out.onboarded = Boolean(out.onboarded);
  out.provider.baseUrl = String(out.provider.baseUrl || '').trim().replace(/\/+$/, '');
  out.provider.model = String(out.provider.model || '').trim();
  out.provider.temperature = clamp(out.provider.temperature, 0, 1.5, 0.4);
  out.realtime.intervalMs = Math.round(clamp(out.realtime.intervalMs, 500, 5000, 900));
  out.realtime.fontSize = Math.round(clamp(out.realtime.fontSize, 14, 40, 20));
  out.realtime.opacity = clamp(out.realtime.opacity, 0.35, 1, 0.92);
  out.realtime.engine = ['auto', 'free', 'ai'].includes(out.realtime.engine)
    ? out.realtime.engine
    : 'auto';
  out.realtime.maxLines = Math.round(clamp(out.realtime.maxLines, 1, 6, 3));
  out.realtime.sourceLang = ['auto', ...REALTIME_LANG_CODES].includes(out.realtime.sourceLang)
    ? out.realtime.sourceLang
    : 'auto';
  out.realtime.targetLang = ['auto', ...REALTIME_LANG_CODES].includes(out.realtime.targetLang)
    ? out.realtime.targetLang
    : 'auto';
  const boxWidth = Math.round(Number(out.realtime.boxWidth) || 0);
  const boxHeight = Math.round(Number(out.realtime.boxHeight) || 0);
  out.realtime.boxWidth = boxWidth >= 320 ? Math.min(1600, boxWidth) : 0;
  out.realtime.boxHeight = boxHeight >= 96 ? Math.min(700, boxHeight) : 0;
  out.historyLimit = Math.round(clamp(out.historyLimit, 10, 300, 60));
  for (const key of ['select', 'realtime']) {
    out.hotkeys[key] = String(out.hotkeys[key] || DEFAULTS.hotkeys[key]).trim();
  }
  out.launchAtLogin = Boolean(out.launchAtLogin);
  out.historyPaused = Boolean(out.historyPaused);
  out.audio = isObject(out.audio) ? out.audio : {};
  out.audio.source = ['system', 'microphone'].includes(out.audio.source) ? out.audio.source : 'system';
  if (out.audio.chunkMs === 6000 && out.audio.overlapMs === 1200) {
    out.audio.chunkMs = 4000;
    out.audio.overlapMs = 2000;
  }
  out.audio.language = ['auto', 'zh', 'en', 'ja', 'ko', 'ru', 'fr', 'de', 'es', 'pt', 'it'].includes(out.audio.language) ? out.audio.language : 'zh';
  out.audio.model = ['base', 'small'].includes(out.audio.model) ? out.audio.model : 'base';
  out.audio.chunkMs = Math.round(clamp(out.audio.chunkMs, 2500, 8000, 4000));
  out.audio.overlapMs = Math.round(clamp(out.audio.overlapMs, 300, 2500, 2000));
  return out;
}

class SettingsStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.data = this.load();
  }

  load() {
    let raw = {};
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = {};
    }
    if (raw && raw.provider) {
      if (raw.provider.apiKeyEnc && raw.provider.apiKeyEnc.length) {
        try {
          raw.provider.apiKey = safeStorage.decryptString(
            Buffer.from(raw.provider.apiKeyEnc, 'base64'),
          );
        } catch {
          raw.provider.apiKey = '';
        }
      } else if (raw.provider.apiKeyPlain) {
        raw.provider.apiKey = raw.provider.apiKeyPlain;
      }
      delete raw.provider.apiKeyEnc;
      delete raw.provider.apiKeyPlain;
    }
    return sanitize(raw);
  }

  get() {
    return this.data;
  }

  update(patch) {
    const next = merge(this.data, patch || {});
    this.data = sanitize(next);
    this.save();
    return this.data;
  }

  save() {
    const plain = JSON.parse(JSON.stringify(this.data));
    const key = plain.provider.apiKey;
    delete plain.provider.apiKey;
    if (key) {
      if (safeStorage.isEncryptionAvailable()) {
        plain.provider.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
      } else {
        plain.provider.apiKeyPlain = key;
      }
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(plain, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  getPublic() {
    const copy = JSON.parse(JSON.stringify(this.data));
    const apiKey = copy.provider.apiKey || '';
    delete copy.provider.apiKey;
    copy.provider.hasApiKey = Boolean(apiKey);
    copy.provider.keyHint = apiKey ? `••••${apiKey.slice(-4)}` : '';
    return copy;
  }

  hasProvider() {
    const provider = this.data.provider;
    const local = /localhost|127\.0\.0\.1|\[::1\]/.test(provider.baseUrl || '');
    return Boolean(provider.baseUrl && provider.model && (provider.apiKey || local));
  }
}

module.exports = { SettingsStore, DEFAULTS, TARGET_LANGS, REALTIME_LANG_CODES, DOMAINS };
