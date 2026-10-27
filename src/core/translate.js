const { streamChat, providerLabel } = require('./llm');
const { buildTranslateSystem } = require('./prompts');

const LANG_NAMES = {
  'zh-CN': '简体中文',
  en: 'English',
  ja: '日本語',
  ko: '한국어',
  ru: 'Русский',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  it: 'Italiano',
  auto: '自动',
};

const MEMORY_LANG = {
  'zh-CN': 'zh-CN',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  ru: 'ru',
  fr: 'fr',
  de: 'de',
  es: 'es',
  pt: 'pt',
  it: 'it',
};

function detectLang(text) {
  const value = String(text || '');
  const count = (re) => (value.match(re) || []).length;
  const kana = count(/[\u3040-\u30ff]/g);
  const hangul = count(/[\uac00-\ud7af]/g);
  const cjk = count(/[\u3400-\u4dbf\u4e00-\u9fff]/g);
  const cyrillic = count(/[\u0400-\u04ff]/g);
  const latin = count(/[A-Za-z]/g);
  if (kana >= 2 && kana >= cjk * 0.15) return 'ja';
  if (hangul >= 2) return 'ko';
  if (cjk >= 1 && cjk >= latin * 0.12) return 'zh-CN';
  if (cyrillic >= 2) return 'ru';
  return 'en';
}

function resolveDirection(text, settings) {
  const source = detectLang(text);
  let target = settings.targetLang;
  if (settings.smartSwap) {
    if (source === target) target = target === 'zh-CN' ? 'en' : 'zh-CN';
    else if (source === 'zh-CN' && target === 'ja') target = 'ja';
  }
  return { source, target };
}

function resolveRealtimeDirection(text, settings) {
  const rt = settings.realtime || {};
  const pinned = rt.sourceLang && rt.sourceLang !== 'auto' ? rt.sourceLang : '';
  const source = pinned || detectLang(text);
  if (rt.targetLang && rt.targetLang !== 'auto') return { source, target: rt.targetLang };
  let target = settings.targetLang;
  if (!pinned && settings.smartSwap) {
    if (source === target) target = target === 'zh-CN' ? 'en' : 'zh-CN';
    else if (source === 'zh-CN' && target === 'ja') target = 'ja';
  }
  return { source, target };
}

function decodeEntities(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function splitLongLine(line, max) {
  const sentences = line.split(/(?<=[。！？!?；;…])/);
  const out = [];
  let buffer = '';
  for (const sentence of sentences) {
    if ((buffer + sentence).length <= max) {
      buffer += sentence;
      continue;
    }
    if (buffer) out.push(buffer);
    buffer = '';
    if (sentence.length > max) {
      for (let i = 0; i < sentence.length; i += max) out.push(sentence.slice(i, i + max));
    } else {
      buffer = sentence;
    }
  }
  if (buffer) out.push(buffer);
  return out;
}

function chunkText(text, max = 480) {
  const lines = String(text).split('\n');
  const chunks = [];
  let buffer = '';
  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.replace(/\s+$/, ''));
    buffer = '';
  };
  for (const line of lines) {
    if (line.length > max) {
      flush();
      for (const piece of splitLongLine(line, max)) {
        if (piece.trim()) chunks.push(piece);
      }
      continue;
    }
    if ((buffer + (buffer ? '\n' : '') + line).length > max) flush();
    buffer += (buffer ? '\n' : '') + line;
  }
  flush();
  return chunks;
}

let memoryUsage = { count: 0, resetAt: 0 };

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
}

async function translateFree(text, from, to, { signal } = {}) {
  const source = MEMORY_LANG[from] || 'en';
  const target = MEMORY_LANG[to] || 'zh-CN';
  const chunks = chunkText(text);
  if (!chunks.length) return { text: '', provider: '免费翻译', chunks: 0 };
  const results = [];
  for (const chunk of chunks) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
    const res = await fetch(url, {
      signal: withTimeout(signal, 25000),
      headers: { 'User-Agent': 'ScreenLens/1.0' },
    });
    if (!res.ok) throw new Error(`免费翻译服务无响应（${res.status}）`);
    const data = await res.json();
    if (String(data.responseStatus) !== '200') {
      const detail = data.responseDetails || '请求被拒绝';
      if (String(detail).includes('QUERY LENGTH')) throw new Error('文本太长，免费翻译无法处理');
      throw new Error(`免费翻译失败：${detail}`);
    }
    const value = decodeEntities(data.responseData?.translatedText || '');
    if (!value) throw new Error('免费翻译没有返回结果');
    results.push(value.replace(/\s+$/, ''));
  }
  memoryUsage.count += String(text).length;
  return {
    text: results.join('\n').trim(),
    provider: '免费翻译',
    chunks: chunks.length,
  };
}

async function translateAI(text, from, to, {
  provider,
  signal,
  onDelta,
  domain = 'general',
  realtime = false,
  image = '',
} = {}) {
  const targetName = LANG_NAMES[to] || to;
  const system = buildTranslateSystem(targetName, domain, {
    realtime,
    vision: Boolean(image),
  });
  const userText = `Text to translate (OCR hint):\n<<<\n${text}\n>>>`;
  const userContent = image
    ? [
      { type: 'text', text: userText },
      { type: 'image_url', image_url: { url: image } },
    ]
    : userText;
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
  let output = '';
  const full = await streamChat({
    provider,
    messages,
    temperature: 0.2,
    maxTokens: realtime ? 280 : 2200,
    signal,
    onDelta: (delta) => {
      output += delta;
      onDelta?.(delta);
    },
  });
  return {
    text: domain === 'code'
      ? normalizeCodeLayout(cleanModelText(full || output, { keepFences: true }))
      : cleanModelText(full || output),
    provider: providerLabel(provider),
  };
}

function fixPythonLayout(body) {
  const out = [];
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^(\s*)(def|class)\s+([^:]+):\s+(\S.*)$/);
    if (!match) {
      out.push(line);
      continue;
    }
    const [, indent, keyword, head, rest] = match;
    if (rest.startsWith('#')) {
      out.push(line);
      continue;
    }
    out.push(`${indent}${keyword} ${head.trim()}:`);
    out.push(`${indent}    ${rest.trim()}`);
  }
  return out.join('\n');
}

function normalizeCodeLayout(text) {
  const value = String(text || '');
  const hasFence = /```/.test(value);
  let changed = false;
  const fixedValue = value.replace(/```([A-Za-z0-9+#.-]*)\r?\n([\s\S]*?)```/g, (whole, lang, body) => {
    const python = /^(?:py|python|python3)$/i.test(lang) || (!lang && /^\s*(?:def|class)\s+\w+/m.test(body));
    if (!python) return whole;
    const fixed = fixPythonLayout(body);
    if (fixed !== body) changed = true;
    return '```' + lang + '\n' + fixed + '```';
  });
  if (hasFence) return changed ? fixedValue : value;
  return fixPythonLayout(value);
}

function cleanModelText(text, { keepFences = false } = {}) {
  let value = String(text || '').trim();
  if (!keepFences) {
    value = value.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  if (!value.startsWith('```') &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('“') && value.endsWith('”')))) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

function engineFor(settings, override) {
  const mode = override || settings.translateEngine || 'auto';
  const hasProvider = typeof settings.hasProvider === 'function'
    ? settings.hasProvider()
    : Boolean(settings.provider?.apiKey);
  if (mode === 'free') return 'free';
  if (mode === 'ai') return hasProvider ? 'ai' : 'free';
  return hasProvider ? 'ai' : 'free';
}

module.exports = {
  LANG_NAMES,
  detectLang,
  resolveDirection,
  resolveRealtimeDirection,
  chunkText,
  translateFree,
  translateAI,
  cleanModelText,
  normalizeCodeLayout,
  engineFor,
  memoryUsage,
};
