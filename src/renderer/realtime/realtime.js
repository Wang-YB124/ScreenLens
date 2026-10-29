const api = window.screenlens;
const $ = (id) => document.getElementById(id);

const sub = $('sub');
const translated = $('translated');
const original = $('original');
const dir = $('dir');
const provider = $('provider');
const hint = $('hint');
const scope = $('scope');
const panel = $('panel');
const btnRecord = $('btn-record');
const btnSettings = $('btn-settings');
const btnClose = $('btn-close');
const fontValue = $('font-value');
const fontUp = $('font-up');
const fontDown = $('font-down');
const opacityRange = $('opacity-range');
const opacityValue = $('opacity-value');
const sourceChips = $('source-chips');
const targetChips = $('target-chips');
const previewText = $('preview-text');
const resizeGrip = $('resize-grip');
const resetSizeBtn = $('reset-size');
const btnAutoSize = $('btn-auto-size');
const btnExplain = $('btn-explain');
const explainPanel = $('explain');
const explainState = $('explain-state');
const explainBody = $('explain-body');
const explainClose = $('explain-close');

const LANGS = [
  { code: 'zh-CN', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'ru', label: 'Русский' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
];

const SAMPLE = {
  'zh-CN': '字幕效果预览',
  en: 'Subtitle preview',
  ja: '字幕プレビュー',
  ko: '자막 미리보기',
  ru: 'Предпросмотр субтитров',
  fr: 'Aperçu des sous-titres',
  de: 'Untertitel-Vorschau',
  es: 'Vista previa de subtítulos',
  pt: 'Prévia da legenda',
  it: 'Anteprima sottotitoli',
};

const rt = {
  fontSize: 20,
  opacity: 0.92,
  maxLines: 3,
  sourceLang: 'auto',
  targetLang: 'auto',
};

let hintTimer = null;
let hintReady = false;
let resizeFrame = null;
let resizePending = false;
let manualHeight = false;
let resizing = false;
let resizePointer = null;
let gripFrame = null;
let resizeMoved = false;
let resizeManualBefore = false;
let currentDomain = 'general';
let lastPreview = '';
let editorMode = false;
let panelOpen = false;
let closing = false;
let explainOpen = false;
let explainFor = '';
let explainText = '';
let explainStatus = 'idle';
let explainStale = false;

let dragging = false;
let dragPointer = null;
let dragFrame = null;

function sendHitZone() {
  const meta = document.querySelector('.meta');
  const bottom = meta ? meta.getBoundingClientRect().bottom : 36;
  let gripZone = null;
  if (!panelOpen) {
    const rect = resizeGrip.getBoundingClientRect();
    gripZone = {
      x: Math.floor(rect.x - 5),
      y: Math.floor(rect.y - 5),
      width: Math.ceil(rect.width + 10),
      height: Math.ceil(rect.height + 10),
    };
  }
  api.send('realtime:hitzone', { metaBottom: Math.ceil(bottom + 6), panelOpen: panelOpen || explainOpen, grip: gripZone });
}

function updateLineClamp() {
  let lines = rt.maxLines;
  if (manualHeight) {
    const meta = document.querySelector('.meta');
    const metaH = meta ? meta.offsetHeight : 18;
    const origH = original.offsetHeight;
    const explainH = explainOpen ? Math.min(210, explainPanel.offsetHeight) : 0;
    const available = innerHeight - 14 - 22 - metaH - (origH ? origH + 4 : 0) - explainH - 6;
    const lineH = Math.max(8, rt.fontSize * 1.42);
    lines = Math.max(1, Math.min(12, Math.floor(available / lineH)));
  }
  document.documentElement.style.setProperty('--rt-lines', String(lines));
}

function syncManualUi() {
  btnAutoSize.classList.toggle('hidden', !manualHeight);
}

let saveTimer = null;
let pendingSave = null;

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
  if (manualHeight) {
    sendHitZone();
    return;
  }
  if (dragging) {
    resizePending = true;
    return;
  }
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;
    document.documentElement.style.setProperty('--rt-lines', String(rt.maxLines));
    const meta = document.querySelector('.meta');
    const metaH = meta ? meta.offsetHeight : 16;
    const panelH = panelOpen ? panel.offsetHeight : 0;
    const origH = original.offsetHeight;
    const transH = translated.offsetHeight;
    const explainH = explainOpen ? explainPanel.offsetHeight + 6 : 0;
    const body = panelOpen
      ? panelH + 8
      : (origH ? origH + 4 : 0) + transH + 6;
    const total = 14 + 22 + metaH + body + explainH;
    api.send('realtime:resize', Math.min(640, Math.max(96, Math.ceil(total))));
    sendHitZone();
  });
}

function setLoading(text) {
  translated.className = 'translated loading';
  translated.replaceChildren();
  translated.append(Object.assign(document.createElement('span'), { className: 'spinner' }));
  translated.append(document.createTextNode(text));
}

function updatePreview() {
  previewText.textContent = editorMode
    ? 'const answer = 42; // 代码字幕预览'
    : (lastPreview || SAMPLE[rt.targetLang] || '字幕效果预览');
}

function currentSubtitleText() {
  return (original.textContent || translated.textContent || '').trim();
}

function cleanExplanation(text) {
  return String(text || '')
    .replace(/```[\w-]*\s*/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function setExplainState(text, error = false) {
  explainState.textContent = text || '';
  explainPanel.classList.toggle('error', Boolean(error));
}

function renderCodeExplanation(text, streaming = false) {
  const stick = streaming && (explainBody.scrollHeight - explainBody.scrollTop - explainBody.clientHeight < 40);
  explainBody.replaceChildren();
  const raw = String(text || '').replace(/\r\n/g, '\n');
  const parts = raw.split('```');
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) {
      const lines = part.split('\n');
      const first = lines[0].trim();
      const hasLang = first && /^[A-Za-z0-9+#._-]{1,24}$/.test(first);
      const code = (hasLang ? lines.slice(1) : lines).join('\n').replace(/\n+$/, '');
      const pre = document.createElement('pre');
      const codeEl = document.createElement('code');
      codeEl.textContent = code;
      pre.append(codeEl);
      explainBody.append(pre);
      continue;
    }
    const plain = part
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*]\s+/gm, '• ')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
    if (plain) explainBody.append(document.createTextNode(`${plain}\n`));
  }
  if (stick) explainBody.scrollTop = explainBody.scrollHeight;
}

function renderExplanation(streaming = false) {
  if (editorMode) {
    renderCodeExplanation(explainText, streaming);
    return;
  }
  const cleaned = cleanExplanation(explainText);
  if (streaming || !cleaned) {
    explainBody.textContent = cleaned;
    return;
  }
  renderMath(explainBody, cleaned);
}

function setExplainPanel(open) {
  explainOpen = open;
  explainPanel.hidden = !open;
  sub.classList.toggle('explain-open', open);
  btnExplain.classList.toggle('active', open);
  btnExplain.title = open
    ? (editorMode ? '刷新 AI 审阅' : '刷新 AI 解释')
    : (editorMode ? 'AI 审阅当前代码' : 'AI 解释当前字幕');
  scheduleResize();
}

function startExplain() {
  const text = currentSubtitleText();
  if (!text) {
    flashHint(editorMode ? '还没有可审阅的代码' : '还没有可解释的字幕');
    return;
  }
  explainFor = text;
  explainText = '';
  explainStatus = 'loading';
  explainStale = false;
  explainPanel.classList.remove('error', 'stale');
  explainBody.textContent = editorMode ? '正在审阅代码…' : '正在生成解释…';
  setExplainState(editorMode ? '正在审阅代码…' : '正在生成解释…');
  setExplainPanel(true);
  api.invoke('realtime:explain', { action: 'start' }).then((res) => {
    if (res?.ok) return;
    explainStatus = 'error';
    explainBody.textContent = res?.error || '解释不可用';
    setExplainState('解释不可用', true);
    scheduleResize();
  }).catch((err) => {
    explainStatus = 'error';
    explainBody.textContent = String(err.message || '解释不可用');
    setExplainState('解释不可用', true);
    scheduleResize();
  });
}

function closeExplain() {
  if (!explainOpen) return;
  explainOpen = false;
  explainStatus = 'idle';
  explainFor = '';
  explainText = '';
  explainPanel.hidden = true;
  explainPanel.classList.remove('error', 'stale');
  sub.classList.remove('explain-open');
  btnExplain.classList.remove('active');
  btnExplain.title = editorMode ? 'AI 审阅当前代码' : 'AI 解释当前字幕';
  api.invoke('realtime:explain', { action: 'stop' }).catch(() => {});
  scheduleResize();
}

api.on('realtime:explanation', (payload) => {
  if (!payload) return;
  if (payload.autoOpen && !explainOpen) {
    explainFor = currentSubtitleText();
    explainStale = false;
    explainPanel.classList.remove('error', 'stale');
    setExplainPanel(true);
  }
  if (!explainOpen) return;
  const status = String(payload.status || '');
  if (status === 'loading') {
    explainStatus = 'loading';
    setExplainState(payload.provider ? `${payload.provider} 正在${editorMode ? '审阅' : '解释'}…` : (editorMode ? '正在审阅代码…' : '正在生成解释…'));
    explainBody.textContent = editorMode ? '正在审阅代码…' : '正在生成解释…';
  } else if (status === 'streaming') {
    explainStatus = 'streaming';
    explainText = String(payload.text || '');
    setExplainState(editorMode ? '审阅中…' : '生成中…');
    renderExplanation(true);
  } else if (status === 'done') {
    explainStatus = 'done';
    explainText = String(payload.text || '');
    setExplainState(explainStale
      ? (editorMode ? '代码已更新，点「审阅」刷新' : '字幕已更新，点「解释」刷新')
      : (payload.provider || 'AI'));
    renderExplanation(false);
    explainPanel.classList.remove('error');
  } else if (status === 'error' || status === 'unavailable') {
    explainStatus = 'error';
    explainText = '';
    explainBody.textContent = String(payload.message || '解释暂不可用');
    setExplainState(status === 'unavailable' ? '需要配置 AI 模型' : '解释失败', true);
  }
  scheduleResize();
});

function makeChip(label, code, active, onPick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = active ? 'chip active' : 'chip';
  btn.textContent = label;
  btn.dataset.code = code;
  btn.addEventListener('click', () => onPick(code));
  return btn;
}

function renderChips() {
  const sourceOptions = [{ code: 'auto', label: '自动' }, ...LANGS];
  const targetOptions = [{ code: 'auto', label: '跟随设置' }, ...LANGS];
  sourceChips.replaceChildren(...sourceOptions.map((option) => makeChip(
    option.label,
    option.code,
    option.code === rt.sourceLang,
    (code) => setLanguage('sourceLang', code),
  )));
  targetChips.replaceChildren(...targetOptions.map((option) => makeChip(
    option.label,
    option.code,
    option.code === rt.targetLang,
    (code) => setLanguage('targetLang', code),
  )));
}

function flashHint(text) {
  hint.textContent = text;
  hint.classList.remove('fade');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => hint.classList.add('fade'), 3600);
}

function setLanguage(key, code) {
  if (rt[key] === code) return;
  rt[key] = code;
  renderChips();
  updatePreview();
  api.invoke('realtime:settings', { [key]: code }).catch(() => {});
  flashHint('语言已切换，正在重译…');
}

function syncStepper() {
  fontValue.textContent = String(rt.fontSize);
  fontDown.disabled = rt.fontSize <= 14;
  fontUp.disabled = rt.fontSize >= 40;
}

function applyFont(next) {
  rt.fontSize = Math.max(14, Math.min(40, Math.round(next)));
  document.documentElement.style.setProperty('--rt-font-size', `${rt.fontSize}px`);
  syncStepper();
  updateLineClamp();
  scheduleResize();
  queueSave({ fontSize: rt.fontSize });
}

function queueSave(patch) {
  pendingSave = { ...(pendingSave || {}), ...patch };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 160);
}

function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!pendingSave) return;
  const payload = pendingSave;
  pendingSave = null;
  api.invoke('realtime:settings', payload).catch(() => {});
}

function applyOpacity(percent) {
  const value = Math.max(35, Math.min(100, Math.round(Number(percent) || 92)));
  rt.opacity = value / 100;
  opacityRange.value = String(value);
  opacityValue.textContent = `${value}%`;
  document.documentElement.style.setProperty('--rt-opacity', String(rt.opacity));
  queueSave({ opacity: rt.opacity });
}

function setPanel(open) {
  panelOpen = open;
  panel.hidden = !open;
  sub.classList.toggle('settings-open', open);
  btnSettings.classList.toggle('active', open);
  btnSettings.title = open ? '收起设置' : '字幕设置';
  if (open) updatePreview();
  updateLineClamp();
  scheduleResize();
}

api.on('realtime:init', (config) => {
  if (typeof config.fontSize === 'number') rt.fontSize = config.fontSize;
  if (typeof config.opacity === 'number') rt.opacity = config.opacity;
  if (typeof config.maxLines === 'number') rt.maxLines = config.maxLines;
  rt.sourceLang = config.sourceLang || 'auto';
  rt.targetLang = config.targetLang || 'auto';
  manualHeight = Number(config.boxHeight) > 0;
  sub.classList.toggle('manual-size', manualHeight);
  syncManualUi();
  const scopeLabel = config.scope || (config.windowTitle ? '窗口' : '');
  editorMode = scopeLabel === '代码';
  sub.classList.toggle('editor-mode', editorMode);
  const explainTag = document.querySelector('.explain-tag');
  if (explainTag) explainTag.textContent = editorMode ? 'AI 审阅' : 'AI 解释';
  const explainLabel = btnExplain.querySelector('span');
  if (explainLabel) explainLabel.textContent = editorMode ? '审阅' : '解释';
  btnExplain.title = editorMode ? 'AI 审阅当前代码' : 'AI 解释当前字幕';
  btnRecord.classList.toggle('hidden', scopeLabel !== '音频');
  if (scopeLabel) {
    scope.textContent = scopeLabel;
    scope.title = config.windowTitle
      ? `识别窗口：${config.windowTitle}`
      : (scopeLabel === '音频' ? '本地 Whisper · 系统声音/麦克风' : '');
    scope.classList.remove('hidden');
  } else {
    scope.classList.add('hidden');
    scope.title = '';
  }
  document.documentElement.style.setProperty('--rt-font-size', `${rt.fontSize}px`);
  document.documentElement.style.setProperty('--rt-opacity', String(rt.opacity));
  updateLineClamp();
  const percent = Math.round(rt.opacity * 100);
  opacityRange.value = String(percent);
  opacityValue.textContent = `${percent}%`;
  syncStepper();
  renderChips();
  updatePreview();
  if (!hintReady) {
    hintReady = true;
    const label = String(config.hotkey || '').replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ');
    hint.textContent = label ? `${label} 停止` : '再次按下快捷键停止';
    clearTimeout(hintTimer);
    hint.classList.remove('fade');
    hintTimer = setTimeout(() => hint.classList.add('fade'), 6500);
  }
  scheduleResize();
});

function markExplainStale() {
  if (!explainOpen || !explainFor) return;
  const text = currentSubtitleText();
  if (!text || text === explainFor || explainStale) return;
  explainStale = true;
  explainPanel.classList.add('stale');
  if (explainStatus === 'done') {
    setExplainState(editorMode ? '代码已更新，点「审阅」刷新' : '字幕已更新，点「解释」刷新');
  }
}

function renderUpdate(payload) {
  if (explainOpen && !editorMode) setTimeout(markExplainStale, 0);
  if (payload.direction) dir.textContent = payload.direction;
  if (editorMode && payload.file) dir.textContent = payload.file;  if (payload.provider) {
    provider.textContent = payload.provider === '免费翻译' || payload.provider === '微软翻译'
      ? 'FREE'
      : (payload.provider === '原文' ? 'ORIG' : (payload.provider === 'EDITOR' ? 'LOCAL' : 'AI'));
  }
  if (payload.domain) currentDomain = payload.domain;
  if (payload.original !== undefined) {
    const text = String(payload.original || '').trim();
    original.textContent = text;
    original.title = text;
  }
  if (payload.status === 'loading') {
    const hasPrevious = translated.textContent.trim()
      && !translated.querySelector('.waiting-dot')
      && !translated.classList.contains('loading');
    translated.classList.remove('error', 'streaming', 'code-text');
    if (hasPrevious) {
      translated.classList.remove('loading');
      translated.classList.add('pending');
    } else {
      translated.classList.remove('pending');
      setLoading('翻译中…');
    }
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
    lastPreview = text.replace(/\s+/g, ' ').trim().slice(0, 160);
    if (panelOpen) updatePreview();
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
    const message = payload.message || payload.translated || '将选区对准字幕或文字区域';
    translated.append(dot, document.createTextNode(message));
  }
}

api.on('realtime:update', (payload) => {
  renderUpdate(payload);
  scheduleResize();
});

function endMove(event) {
  if (!dragging) return;
  dragging = false;
  dragPointer = null;
  document.body.classList.remove('dragging');
  try {
    if (event && sub.hasPointerCapture(event.pointerId)) {
      sub.releasePointerCapture(event.pointerId);
    }
  } catch {}
  api.send('realtime:drag-end');
  if (resizePending) {
    resizePending = false;
    scheduleResize();
  }
}

function canStartMove(event) {
  if (event.button !== 0 || closing) return false;
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest('button, input, #resize-grip')) return false;
  const meta = document.querySelector('.meta');
  const bandBottom = meta ? meta.getBoundingClientRect().bottom + 6 : 44;
  return event.clientY <= bandBottom;
}

sub.addEventListener('pointerdown', (event) => {
  if (!canStartMove(event)) return;
  event.preventDefault();
  dragging = true;
  dragPointer = event.pointerId;
  try { sub.setPointerCapture(event.pointerId); } catch {}
  document.body.classList.add('dragging');
  api.send('realtime:drag-start');
});

sub.addEventListener('pointermove', (event) => {
  if (!dragging || event.pointerId !== dragPointer || dragFrame) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = null;
    if (dragging) api.send('realtime:drag-move');
  });
});

sub.addEventListener('pointerup', endMove);
sub.addEventListener('pointercancel', endMove);
sub.addEventListener('lostpointercapture', () => {
  if (dragging) endMove(null);
});

btnRecord.addEventListener('click', async () => {
  try {
    const res = await api.invoke('audio:records-open-file');
    flashHint(res?.ok ? '已打开最近记录' : '暂无音频记录');
  } catch {
    flashHint('无法打开记录');
  }
});

btnSettings.addEventListener('click', () => setPanel(!panelOpen));
btnExplain.addEventListener('click', startExplain);
explainClose.addEventListener('click', (event) => {
  event.stopPropagation();
  closeExplain();
});

btnClose.addEventListener('click', () => {
  if (closing) return;
  closing = true;
  flushSave();
  sub.classList.add('closing');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => {
    api.invoke('action:stop-realtime').catch(() => {});
  }, reduce ? 0 : 180);
});

fontDown.addEventListener('click', () => applyFont(rt.fontSize - 2));
fontUp.addEventListener('click', () => applyFont(rt.fontSize + 2));

opacityRange.addEventListener('input', (event) => applyOpacity(event.target.value));
opacityRange.addEventListener('change', flushSave);

for (const row of [sourceChips, targetChips]) {
  row.addEventListener('wheel', (event) => {
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    row.scrollLeft += event.deltaY;
    event.preventDefault();
  }, { passive: false });
}

let gripTitle = resizeGrip.title;

function startGripResize(event) {
  if (event.button !== 0 || closing) return;
  event.preventDefault();
  resizing = true;
  resizePointer = event.pointerId;
  resizeMoved = false;
  resizeManualBefore = manualHeight;
  manualHeight = true;
  try { resizeGrip.setPointerCapture(event.pointerId); } catch {}
  document.body.classList.add('resizing');
  resizeGrip.title = '拖动调整字幕框大小，松开生效';
  api.send('realtime:resize-start');
}

function moveGripResize(event) {
  if (!resizing || event.pointerId !== resizePointer) return;
  resizeMoved = true;
  if (gripFrame) return;
  gripFrame = requestAnimationFrame(() => {
    gripFrame = null;
    if (resizing) api.send('realtime:resize-move');
  });
}

function endGripResize(event) {
  if (!resizing) return;
  const pointer = resizePointer;
  resizing = false;
  resizePointer = null;
  document.body.classList.remove('resizing');
  resizeGrip.title = gripTitle;
  try {
    if (pointer !== null && resizeGrip.hasPointerCapture(pointer)) {
      resizeGrip.releasePointerCapture(pointer);
    }
  } catch {}
  api.send('realtime:resize-end');
  if (resizeMoved) {
    manualHeight = true;
    sub.classList.add('manual-size');
    syncManualUi();
    updateLineClamp();
    api.invoke('realtime:settings', { boxWidth: innerWidth, boxHeight: innerHeight }).catch(() => {});
  } else {
    manualHeight = resizeManualBefore;
    sub.classList.toggle('manual-size', manualHeight);
    syncManualUi();
    updateLineClamp();
  }
  scheduleResize();
}

async function resetSize() {
  try { await api.invoke('realtime:reset-size'); } catch {}
  manualHeight = false;
  sub.classList.remove('manual-size');
  syncManualUi();
  updateLineClamp();
  scheduleResize();
}

resizeGrip.addEventListener('pointerdown', startGripResize);
resizeGrip.addEventListener('pointermove', moveGripResize);
resizeGrip.addEventListener('pointerup', endGripResize);
resizeGrip.addEventListener('pointercancel', endGripResize);
resizeGrip.addEventListener('lostpointercapture', () => {
  if (resizing) endGripResize(null);
});
resizeGrip.addEventListener('dblclick', resetSize);
resetSizeBtn.addEventListener('click', resetSize);
btnAutoSize.addEventListener('click', resetSize);

window.addEventListener('resize', () => {
  updateLineClamp();
  sendHitZone();
});

renderChips();
updatePreview();
syncStepper();
scheduleResize();