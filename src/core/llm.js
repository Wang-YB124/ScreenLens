const { Readable } = require('stream');

const PRESET_LABELS = [
  ['api.deepseek.com', 'DeepSeek'],
  ['dashscope.aliyuncs.com', '通义千问'],
  ['moonshot.cn', 'Kimi'],
  ['bigmodel.cn', '智谱 GLM'],
  ['openai.com', 'OpenAI'],
  ['127.0.0.1', '本地模型'],
  ['localhost', '本地模型'],
  ['siliconflow.cn', 'SiliconFlow'],
];

function providerLabel(provider) {
  const baseUrl = String(provider?.baseUrl || '');
  for (const [needle, label] of PRESET_LABELS) {
    if (baseUrl.includes(needle)) return label;
  }
  return 'AI 模型';
}

function isLocalProvider(baseUrl) {
  return /localhost|127\.0\.0\.1|\[::1\]/.test(String(baseUrl || ''));
}

function endpointOf(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置模型地址');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function combinedSignal(signal, timeoutMs) {
  const signals = [];
  if (signal) signals.push(signal);
  if (AbortSignal.timeout) signals.push(AbortSignal.timeout(timeoutMs));
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any ? AbortSignal.any(signals) : signals[0];
}

async function errorFromResponse(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json.error?.message || json.message || json.error || text;
    } catch {
      detail = text;
    }
  } catch {}
  detail = String(detail || '').replace(/\s+/g, ' ').slice(0, 400);
  const hint = res.status === 401
    ? 'API Key 无效或已过期'
    : res.status === 404
      ? '接口地址或模型名不存在'
      : res.status === 429
        ? '请求太频繁或额度不足'
        : `模型服务返回 ${res.status}`;
  throw new Error(`${hint}${detail ? `：${detail}` : ''}`);
}

function payloadFor(provider, messages, { stream, maxTokens, temperature }) {
  const body = {
    model: provider.model,
    messages,
    stream: Boolean(stream),
    temperature: temperature ?? provider.temperature ?? 0.4,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  return body;
}

async function chat({ provider, messages, signal, maxTokens, temperature, timeoutMs = 90000 }) {
  if (!provider?.apiKey && !isLocalProvider(provider?.baseUrl)) throw new Error('尚未配置 API Key');
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ScreenLens/1.0',
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  let res;
  try {
    res = await fetch(endpointOf(provider.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(payloadFor(provider, messages, {
        stream: false,
        maxTokens,
        temperature,
      })),
      signal: combinedSignal(signal, timeoutMs),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('无法连接模型服务，请检查网络或接口地址');
  }
  if (!res.ok) await errorFromResponse(res);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('模型没有返回文本');
  return content.trim();
}

async function streamChat({
  provider,
  messages,
  onDelta,
  signal,
  maxTokens,
  temperature,
  timeoutMs = 120000,
}) {
  if (!provider?.apiKey && !isLocalProvider(provider?.baseUrl)) throw new Error('尚未配置 API Key');
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'ScreenLens/1.0',
  };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  let res;
  try {
    res = await fetch(endpointOf(provider.baseUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify(payloadFor(provider, messages, {
        stream: true,
        maxTokens,
        temperature,
      })),
      signal: combinedSignal(signal, timeoutMs),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('无法连接模型服务，请检查网络或接口地址');
  }
  if (!res.ok) await errorFromResponse(res);
  if (!res.body) throw new Error('模型响应为空');

  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let full = '';
  let finished = false;

  const consume = (chunk) => {
    buffer += chunk;
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        finished = true;
        continue;
      }
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue;
      }
      if (json.error) throw new Error(json.error.message || '模型返回错误');
      const choice = json.choices?.[0];
      const delta = choice?.delta?.content ?? choice?.message?.content ?? '';
      if (delta) {
        full += delta;
        onDelta?.(delta);
      }
      if (choice?.finish_reason) finished = true;
    }
  };

  if (typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
      if (finished) {
        try { await reader.cancel(); } catch {}
        break;
      }
    }
  } else {
    for await (const chunk of Readable.fromWeb(res.body)) {
      consume(decoder.decode(chunk, { stream: true }));
      if (finished) break;
    }
  }
  consume(decoder.decode());
  return full.trim();
}

async function testProvider(provider) {
  const started = Date.now();
  const reply = await chat({
    provider,
    messages: [{ role: 'user', content: '请只回复：OK' }],
    maxTokens: 8,
    temperature: 0,
    timeoutMs: 20000,
  });
  return { ok: true, ms: Date.now() - started, reply: reply.slice(0, 80) };
}

module.exports = {
  chat,
  streamChat,
  testProvider,
  providerLabel,
  endpointOf,
  isLocalProvider,
};
