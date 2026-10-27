const api = window.screenlens;
const $ = (id) => document.getElementById(id);

const sub = $('sub');
const translated = $('translated');
const original = $('original');
const dir = $('dir');
const provider = $('provider');
const hint = $('hint');

let hintTimer = null;
let resizeFrame = null;
let currentDomain = 'general';

function mathSegments(text) {
  const pattern = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g;
  const segments = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) segments.push({ type: 'text', value: text.slice(last, match.index) });
    const token = match[0];
    let body = token;
    let display = false;
    if (token.startsWith('$$')) {
      body = token.slice(2, -2);
      display = true;
    } else if (token.startsWith('$')) {
      body = token.slice(1, -1);
    } else if (token.startsWith('\\(')) {
      body = token.slice(2, -2);
    } else {
      body = token.slice(2, -2);
      display = true;
    }
    segments.push({ type: 'math', value: body, display, raw: token });
    last = match.index + token.length;
  }
  if (last < text.length) segments.push({ type: 'text', value: text.slice(last) });
  return segments;
}

function renderMath(node, text) {
  node.replaceChildren();
  const segments = mathSegments(text);
  for (const segment of segments) {
    if (segment.type === 'text') {
      node.append(document.createTextNode(segment.value));
      continue;
    }
    const span = document.createElement('span');
    span.className = 'math-inline';
    try {
      if (!window.katex) throw new Error('katex missing');
      span.innerHTML = window.katex.renderToString(segment.value, {
        displayMode: false,
        throwOnError: true,
        trust: false,
        strict: false,
        output: 'html',
      });
    } catch {
      span.textContent = segment.raw;
      span.classList.add('math-fallback');
    }
    node.append(span);
  }
}

function scheduleResize() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    const meta = document.querySelector('.meta');
    const wrap = document.querySelector('.wrap');
    const metaH = meta ? meta.offsetHeight : 14;
    const origH = original.offsetHeight;
    const transH = translated.offsetHeight;
    const total = 14 + 22 + metaH + (origH ? origH + 4 : 0) + transH + 6;
    api.send('realtime:resize', Math.min(340, Math.max(96, Math.ceil(total))));
  });
}

function setLoading(text) {
  translated.className = 'translated loading';
  translated.replaceChildren();
  translated.append(Object.assign(document.createElement('span'), { className: 'spinner' }));
  translated.append(document.createTextNode(text));
}

api.on('realtime:init', (config) => {
  document.documentElement.style.setProperty('--rt-font-size', `${config.fontSize}px`);
  document.documentElement.style.setProperty('--rt-opacity', String(config.opacity));
  document.documentElement.style.setProperty('--rt-lines', String(config.maxLines));
  hint.textContent = `${String(config.hotkey || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ')} 停止`;
  clearTimeout(hintTimer);
  hint.classList.remove('fade');
  hintTimer = setTimeout(() => hint.classList.add('fade'), 6500);
  scheduleResize();
});

function renderUpdate(payload) {
  if (payload.direction) dir.textContent = payload.direction;
  if (payload.provider) provider.textContent = payload.provider === '免费翻译' ? 'FREE' : 'AI';
  if (payload.domain) currentDomain = payload.domain;
  if (payload.original !== undefined) {
    const text = String(payload.original || '').trim();
    original.textContent = text;
    original.title = text;
  }
  if (payload.status === 'loading') {
    setLoading('翻译中…');
    translated.classList.remove('error', 'streaming', 'code-text');
    return;
  }
  if (payload.status === 'streaming') {
    translated.className = 'translated streaming';
    if (currentDomain === 'code') translated.classList.add('code-text');
    translated.textContent = payload.translated || '';
    return;
  }
  if (payload.status === 'done') {
    translated.className = 'translated';
    if (payload.direction && String(payload.direction).includes('中文')) translated.classList.add('cjk');
    if (currentDomain === 'code') translated.classList.add('code-text');
    const text = payload.translated || '';
    if (currentDomain !== 'code' && /\$|\\\(|\\\[/.test(text)) renderMath(translated, text);
    else translated.textContent = text;
    return;
  }
  if (payload.status === 'error') {
    translated.className = 'translated error';
    translated.textContent = `翻译暂不可用：${String(payload.message || '请稍后再试').slice(0, 80)}`;
    return;
  }
  if (payload.status === 'waiting') {
    translated.className = 'translated';
    translated.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'waiting-dot';
    translated.append(dot, document.createTextNode('将选区对准字幕或文字区域'));
  }
}

api.on('realtime:update', (payload) => {
  renderUpdate(payload);
  scheduleResize();
});

scheduleResize();
