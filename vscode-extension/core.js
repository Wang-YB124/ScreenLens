const http = require('http');
const https = require('https');
const { URL } = require('url');
const { version } = require('./package.json');

function isLocalBaseUrl(baseUrl) {
  return /localhost|127\.0\.0\.1|\[::1\]/i.test(String(baseUrl || ''));
}

function endpointOf(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('未配置接口地址');
  return /\/chat\/completions$/i.test(base) ? base : `${base}/chat/completions`;
}

function requestChat({
  baseUrl,
  model,
  apiKey,
  messages,
  temperature = 0.2,
  maxTokens = 1800,
  timeoutMs = 120000,
}) {
  if (!model) throw new Error('未配置模型名称');
  if (!apiKey && !isLocalBaseUrl(baseUrl)) throw new Error('尚未配置 API Key');
  const url = new URL(endpointOf(baseUrl));
  const payload = JSON.stringify({
    model,
    messages,
    stream: false,
    temperature,
    max_tokens: maxTokens,
  });
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'User-Agent': `ScreenLens-Code/${version}`,
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(raw); } catch {}
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = data?.error?.message || data?.message || raw.slice(0, 300);
          reject(new Error(`模型服务返回 ${res.statusCode}${detail ? `：${detail}` : ''}`));
          return;
        }
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          reject(new Error('模型没有返回内容'));
          return;
        }
        resolve(String(content));
      });
    });
    req.on('timeout', () => req.destroy(new Error('模型请求超时')));
    req.on('error', reject);
    req.end(payload);
  });
}

function stripCodeFence(text) {
  let value = String(text || '').trim();
  const whole = value.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (whole) return whole[1];
  const first = value.match(/```[^\n]*\n([\s\S]*?)```/);
  if (first) value = first[1];
  return value.trim();
}

function normalizeEol(text, eol) {
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  return eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

module.exports = {
  isLocalBaseUrl,
  endpointOf,
  requestChat,
  stripCodeFence,
  normalizeEol,
};
