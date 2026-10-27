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

const BING_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';
const BING_HOST = 'https://cn.bing.com';
const BING_IID = 'translator.5026';
const BING_LANG = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
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
const FREE_CACHE_TTL = 15 * 60 * 1000;
const FREE_CACHE_LIMIT = 200;
const freeCache = new Map();
let bingAuth = null;
let bingAuthAt = 0;
let bingAuthPending = null;

function withTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  return AbortSignal.any ? AbortSignal.any([signal, timeout]) : signal;
}

function freeCacheKey(from, to, text) {
  return `${from}\u0000${to}\u0000${text}`;
}

function freeCacheGet(key) {
  const item = freeCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    freeCache.delete(key);
    return null;
  }
  freeCache.delete(key);
  freeCache.set(key, item);
  return item.value;
}

function freeCacheSet(key, value) {
  if (!value?.text) return;
  if (freeCache.size >= FREE_CACHE_LIMIT) {
    const oldest = freeCache.keys().next().value;
    if (oldest !== undefined) freeCache.delete(oldest);
  }
  freeCache.set(key, { value, expires: Date.now() + FREE_CACHE_TTL });
}

async function loadBingAuth(signal) {
  if (bingAuth && Date.now() - bingAuthAt < 30 * 60 * 1000) return bingAuth;
  if (bingAuthPending) return bingAuthPending;
  bingAuthPending = (async () => {
    let res;
    try {
      res = await fetch(`${BING_HOST}/translator`, {
        headers: {
          'User-Agent': BING_UA,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: withTimeout(signal, 12000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error('无法连接翻译服务，请检查网络');
    }
    if (!res.ok) throw new Error(`翻译服务无响应（${res.status}）`);
    const html = await res.text();
    const ig = html.match(/IG:"([^"]+)"/)?.[1] || '';
    const auth = html.match(/params_AbusePreventionHelper\s*=\s*\[(\d+),\s*"([^"]+)",\s*(\d+)\]/);
    if (!ig || !auth) throw new Error('翻译服务鉴权失败');
    bingAuth = { ig, token: auth[2], key: auth[1] };
    bingAuthAt = Date.now();
    return bingAuth;
  })().finally(() => {
    bingAuthPending = null;
  });
  return bingAuthPending;
}

async function warmFreeTranslator() {
  try {
    await loadBingAuth();
    return true;
  } catch {
    return false;
  }
}

function bingLang(code, source = false) {
  if (!code || code === 'auto') return source ? 'auto-detect' : 'zh-Hans';
  return BING_LANG[code] || code;
}

async function translateBingChunk(text, from, to, signal) {
  let refreshed = false;
  for (;;) {
    const auth = await loadBingAuth(signal);
    const body = new URLSearchParams({
      fromLang: bingLang(from, true),
      text,
      to: bingLang(to),
      token: auth.token,
      key: auth.key,
    });
    let res;
    try {
      res = await fetch(`${BING_HOST}/ttranslatev3?isVertical=1&&IG=${encodeURIComponent(auth.ig)}&IID=${BING_IID}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': BING_UA,
          Referer: `${BING_HOST}/translator`,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        body,
        signal: withTimeout(signal, 18000),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error('无法连接翻译服务，请检查网络');
    }
    if (res.status === 429) throw new Error('免费翻译已限流，请稍后再试');
    if ((res.status === 401 || res.status === 403) && !refreshed) {
      refreshed = true;
      bingAuth = null;
      bingAuthAt = 0;
      continue;
    }
    if (!res.ok) throw new Error(`翻译服务无响应（${res.status}）`);
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('翻译服务返回了无法解析的数据');
    }
    const translated = data?.[0]?.translations?.[0]?.text;
    if (typeof translated === 'string' && translated.trim()) return translated;
    if (data?.statusCode || data?.error) {
      if (!refreshed) {
        refreshed = true;
        bingAuth = null;
        bingAuthAt = 0;
        continue;
      }
      throw new Error('翻译服务暂时不可用');
    }
    throw new Error('翻译服务没有返回结果');
  }
}

async function translateBing(text, from, to, { signal, onPartial } = {}) {
  const chunks = chunkText(text, 1200);
  if (!chunks.length) return { text: '', chunks: 0 };
  const results = new Array(chunks.length);
  let cursor = 0;
  let shown = 0;
  const emit = () => {
    if (!onPartial || signal?.aborted) return;
    let prefix = 0;
    while (prefix < results.length && typeof results[prefix] === 'string') prefix += 1;
    if (prefix <= shown) return;
    shown = prefix;
    try {
      onPartial(results.slice(0, prefix).join('\n').trim());
    } catch {}
  };
  const worker = async () => {
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await translateBingChunk(chunks[index], from, to, signal);
      emit();
    }
  };
  const settled = await Promise.allSettled(
    Array.from({ length: Math.min(2, chunks.length) }, () => worker()),
  );
  const failed = settled.find((item) => item.status === 'rejected');
  if (failed) throw failed.reason;
  return { text: results.join('\n').trim(), chunks: chunks.length };
}

async function translateFree(text, from, to, { signal, onPartial } = {}) {
  const source = MEMORY_LANG[from] || 'en';
  const target = MEMORY_LANG[to] || 'zh-CN';
  const plain = String(text || '');
  if (!plain.trim()) return { text: '', provider: '免费翻译', chunks: 0 };

  const key = freeCacheKey(source, target, plain);
  const cached = freeCacheGet(key);
  if (cached) {
    try { onPartial?.(cached.text); } catch {}
    return { ...cached, cached: true };
  }

  try {
    const result = await translateBing(plain, source, target, { signal, onPartial });
    const value = { text: result.text, provider: '微软翻译', chunks: result.chunks };
    freeCacheSet(key, value);
    return value;
  } catch (err) {
    if (signal?.aborted) throw err;
  }

  const chunks = chunkText(plain);
  if (!chunks.length) return { text: '', provider: '免费翻译', chunks: 0 };
  const results = [];
  for (const chunk of chunks) {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(chunk)}&langpair=${encodeURIComponent(source)}|${encodeURIComponent(target)}`;
    let res;
    try {
      res = await fetch(url, {
        signal: withTimeout(signal, 25000),
        headers: { 'User-Agent': 'ScreenLens/1.0' },
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new Error('无法连接免费翻译服务，请检查网络，或在设置中配置 AI 模型');
    }
    if (!res.ok) {
      if (res.status === 429) {
        throw new Error('免费翻译已限流，请稍后再试，或在设置中配置 AI 模型');
      }
      throw new Error(`免费翻译服务无响应（${res.status}）`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('免费翻译返回了无法解析的数据，请稍后重试');
    }
    if (String(data.responseStatus) !== '200') {
      const detail = data.responseDetails || '请求被拒绝';
      if (String(data.responseStatus) === '429' || /too many requests/i.test(String(detail))) {
        throw new Error('免费翻译已限流，请稍后再试，或在设置中配置 AI 模型');
      }
      if (String(detail).includes('QUERY LENGTH')) throw new Error('文本太长，免费翻译无法处理');
      throw new Error(`免费翻译失败：${detail}`);
    }
    const value = decodeEntities(data.responseData?.translatedText || '');
    if (!value) throw new Error('免费翻译没有返回结果');
    results.push(value.replace(/\s+$/, ''));
    try {
      onPartial?.(results.join('\n').trim());
    } catch {}
  }
  memoryUsage.count += String(text).length;
  const value = {
    text: results.join('\n').trim(),
    provider: '免费翻译',
    chunks: chunks.length,
  };
  freeCacheSet(key, value);
  return value;
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
  warmFreeTranslator,
  cleanModelText,
  normalizeCodeLayout,
  engineFor,
  memoryUsage,
};
