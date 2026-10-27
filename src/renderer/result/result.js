const api = window.screenlens;
const $ = (id) => document.getElementById(id);

const LANG_LABEL = { 'zh-CN': '中文', en: 'EN', ja: '日文', ko: '韩文', ru: 'RU', fr: 'FR', de: 'DE', es: 'ES', pt: 'PT', it: 'IT', auto: 'AUTO' };
const DOMAIN_LABELS = {
  auto: '自动',
  general: '通用',
  code: '代码',
  math: '数学',
  science: '科普',
};
const CODE_LANGS = new Set([
  'js', 'javascript', 'jsx', 'ts', 'typescript', 'tsx', 'py', 'python', 'rb', 'ruby',
  'sh', 'bash', 'shell', 'zsh', 'ps1', 'powershell', 'c', 'h', 'cpp', 'c++', 'cc',
  'cs', 'csharp', 'c#', 'java', 'kt', 'kotlin', 'go', 'rust', 'rs', 'swift',
  'php', 'sql', 'html', 'xml', 'vue', 'css', 'scss', 'less', 'json', 'yaml', 'yml',
  'toml', 'ini', 'md', 'markdown', 'lua', 'r', 'matlab', 'tex', 'latex',
]);
const LANG_ALIASES = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  'c++': 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  'c#': 'csharp',
  kt: 'kotlin',
  rs: 'rust',
  html: 'xml',
  vue: 'xml',
  yml: 'yaml',
  md: 'markdown',
};
const ICONS = {
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 8v4.5M12 16h.01"/></svg>',
  empty: '<svg viewBox="0 0 24 24"><path d="M4 8V5.8C4 4.8 4.8 4 5.8 4H8M16 4h2.2c1 0 1.8.8 1.8 1.8V8M20 16v2.2c0 1-.8 1.8-1.8 1.8H16M8 20H5.8c-1 0-1.8-.8-1.8-1.8V16"/><path d="M9 12h6"/></svg>',
  spark: '<svg viewBox="0 0 24 24"><path d="M12 3.5 13.9 10 20.5 12 13.9 14 12 20.5 10.1 14 3.5 12 10.1 10Z"/></svg>',
  key: '<svg viewBox="0 0 24 24"><circle cx="8.5" cy="12" r="3.5"/><path d="M12 12h8M17 12v3M20 12v2"/></svg>',
  globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.2 3.3 5 3.3 8.5S14.2 18.3 12 20.5c-2.2-2.2-3.3-5-3.3-8.5S9.8 5.7 12 3.5Z"/></svg>',
  external: '<svg viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8"/><path d="M18 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h4"/></svg>',
};

let record = null;
let activePane = 'translation';
let explainRequested = false;
let localExplainLoading = false;
let relatedRequested = false;
let pinned = true;
let sourceExpanded = false;
let frames = { translation: null, explanation: null };
let toastTimer = null;
let visionHintDismissed = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function iconBox(className, icon) {
  const box = el('div', className);
  box.innerHTML = ICONS[icon] || ICONS.spark;
  return box;
}

function langLabel(lang) {
  return LANG_LABEL[lang] || String(lang || '').toUpperCase();
}

function domainLabel(domain) {
  return DOMAIN_LABELS[domain] || DOMAIN_LABELS.general;
}

function cardToast(message) {
  const node = $('card-toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1500);
}

async function copyText(text, message = '已复制到剪贴板') {
  if (!String(text || '').trim()) {
    cardToast('暂无可复制的内容');
    return;
  }
  try {
    await api.invoke('action:copy', text);
    cardToast(message);
  } catch {
    cardToast('复制失败');
  }
}

function show(rec) {
  record = rec;
  activePane = 'translation';
  explainRequested = false;
  localExplainLoading = false;
  relatedRequested = false;
  sourceExpanded = false;
  pinned = true;
  visionHintDismissed = false;
  for (const key of Object.keys(frames)) {
    if (frames[key]) cancelAnimationFrame(frames[key]);
    frames[key] = null;
  }
  $('source-text').classList.remove('expanded');
  $('source-text').classList.add('clamped');
  $('source-toggle').textContent = '展开';
  $('content-scroll').scrollTop = 0;
  const card = $('card');
  card.classList.remove('enter');
  void card.offsetWidth;
  card.classList.add('enter');
  renderAll();
}

function updateRecord(next) {
  if (!record || next.id !== record.id) {
    show(next);
    return;
  }
  record = next;
  if (next.explanation.status !== 'loading') localExplainLoading = false;
  renderAll();
}

function renderAll() {
  if (!record) return;
  renderHeader();
  renderSource();
  renderTabs();
  renderTranslation();
  renderExplanation();
  renderRelated();
  renderFooter();
  syncDomainSelect();
  if (activePane === 'explanation') ensureExplanation();
  if (activePane === 'related') ensureRelated();
}

function renderHeader() {
  const meta = record.meta || {};
  $('brand-title').textContent = activePane === 'translation'
    ? '译文'
    : activePane === 'explanation' ? '解释' : '相关';
  $('dir-chip').textContent = meta.sourceLang && meta.sourceLang !== 'auto'
    ? `${langLabel(meta.sourceLang)} → ${langLabel(meta.targetLang)}`
    : '识别中…';
  const pin = $('pin-btn');
  pin.classList.toggle('pinned', pinned);
  pin.title = pinned ? '取消置顶' : '置顶窗口';
}

function renderSource() {
  const block = $('source-block');
  const text = record.source || '';
  if (!text || record.translation.status === 'ocr') {
    block.classList.add('hidden');
    return;
  }
  block.classList.remove('hidden');
  const meta = record.meta || {};
  const domain = meta.domain && meta.domain !== 'general' ? ` · ${domainLabel(meta.domain)}` : '';
  $('source-meta').textContent = `${langLabel(meta.sourceLang)} · ${text.length} 字符${domain} · 本地 OCR`;
  const node = $('source-text');
  if (node.textContent !== text) node.textContent = text;
  const toggle = $('source-toggle');
  const needToggle = text.length > 58 || text.split('\n').length > 2;
  toggle.classList.toggle('hidden', !needToggle);
  if (!needToggle) {
    node.classList.remove('clamped', 'expanded');
  } else if (sourceExpanded) {
    node.classList.remove('clamped');
    node.classList.add('expanded');
    toggle.textContent = '收起';
  }
}

function renderTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.classList.toggle('active', tab.dataset.pane === activePane);
  }
  $('pane-translation').classList.toggle('hidden', activePane !== 'translation');
  $('pane-explanation').classList.toggle('hidden', activePane !== 'explanation');
  $('pane-related').classList.toggle('hidden', activePane !== 'related');
  $('brand-title').textContent = activePane === 'translation'
    ? '译文'
    : activePane === 'explanation' ? '解释' : '相关';
}

function syncDomainSelect() {
  const select = $('domain-select');
  if (!select) return;
  const meta = record?.meta || {};
  const detected = meta.detectedDomain || meta.domain || 'general';
  const autoOption = select.querySelector('option[value="auto"]');
  if (autoOption) autoOption.textContent = `自动 · ${domainLabel(detected)}`;
  if (document.activeElement !== select) select.value = meta.domainMode || 'auto';
  select.disabled = !record?.source;
}

function loader(title, lines = ['w95', 'w80', 'w60']) {
  const wrap = el('div', 'loader');
  const head = el('div', 'loader-head');
  head.append(el('span', 'spinner'), document.createTextNode(title));
  wrap.append(head);
  for (const width of lines) wrap.append(el('div', `skeleton skeleton-line ${width}`));
  return wrap;
}

function errorCard(title, message, actions, hint = '可以重试，或换用免费翻译通道。') {
  const card = el('div', 'error-card');
  card.append(iconBox('error-icon', 'error'));
  card.append(el('h3', '', title));
  card.append(el('p', '', hint));
  if (message) card.append(el('div', 'error-message', message));
  const row = el('div', 'card-actions');
  for (const action of actions) {
    const button = el('button', action.primary ? 'btn-primary small' : 'btn-ghost small', action.label);
    button.addEventListener('click', action.onClick);
    row.append(button);
  }
  card.append(row);
  return card;
}

function emptyCard() {
  const card = el('div', 'empty-card');
  card.append(iconBox('empty-icon', 'empty'));
  card.append(el('h3', '', '没有识别到文字'));
  card.append(el('p', '', '试试重新框选——更大、更清晰、对比度更高的区域通常识别得更好。'));
  const tips = el('div', 'empty-tips');
  tips.append(el('span', '', '避开纯图标、背景图和严重反光的区域'));
  tips.append(el('span', '', '小字可以框得更紧一些，让文字占满选区'));
  tips.append(el('span', '', '如果界面开启了深色模式，尽量包含完整的句子'));
  card.append(tips);
  const row = el('div', 'card-actions');
  const reselect = el('button', 'btn-primary small', '重新框选');
  reselect.addEventListener('click', () => api.invoke('action:select'));
  const close = el('button', 'btn-ghost small', '关闭');
  close.addEventListener('click', () => api.invoke('action:close-result'));
  row.append(reselect, close);
  card.append(row);
  return card;
}

function isCjkTarget() {
  const target = String(record?.targetLang || '');
  return target.startsWith('zh') || target === 'ja' || target === 'ko';
}

function shouldShowVisionHint() {
  const meta = record?.meta || {};
  return !visionHintDismissed
    && record?.engine === 'ai'
    && Boolean(meta.hasProvider)
    && !meta.visionUsed
    && !meta.visionEnabled
    && ['code', 'math'].includes(meta.domain)
    && record?.translation?.status === 'done';
}

function visionHint() {
  const wrap = el('div', 'vision-hint');
  const icon = iconBox('vision-hint-icon', 'spark');
  wrap.append(icon);
  const copy = el('div', 'vision-hint-copy');
  copy.append(el('strong', '', '识别可能不完整'));
  copy.append(el('span', '', '公式/代码建议让 AI 读图；截图会发送给模型。'));
  wrap.append(copy);
  const button = el('button', 'btn-small accent', '开启读图');
  button.addEventListener('click', () => enableVision(button));
  wrap.append(button);
  const dismiss = el('button', 'vision-dismiss', '×');
  dismiss.title = '暂不开启';
  dismiss.addEventListener('click', () => {
    visionHintDismissed = true;
    renderTranslation();
  });
  wrap.append(dismiss);
  return wrap;
}

async function enableVision(button) {
  button.disabled = true;
  try {
    await api.invoke('settings:update', { vision: { enabled: true } });
    if (!record) return;
    record.meta = { ...(record.meta || {}), visionEnabled: true, visionUsed: false };
    record.translation = {
      ...record.translation,
      status: 'loading',
      text: '',
      error: '',
      notice: '',
    };
    record.explanation = {
      status: 'idle',
      text: '',
      provider: '',
      error: '',
      notice: '',
      message: '',
    };
    record.related = {
      status: 'idle',
      keywords: [],
      links: [],
      source: '',
      notice: '',
      error: '',
      topic: '',
    };
    explainRequested = false;
    localExplainLoading = false;
    relatedRequested = false;
    renderAll();
    cardToast('已开启 AI 读图，正在重译');
    await api.invoke('action:retranslate');
  } catch (err) {
    cardToast('开启失败：' + err.message);
    button.disabled = false;
  }
}

function renderTranslation() {
  const pane = $('pane-translation');
  const translation = record.translation || {};
  pane.replaceChildren();

  if (translation.status === 'ocr') {
    pane.append(loader('正在识别屏幕文字…', ['w95', 'w80', 'w60']));
    return;
  }
  if (translation.status === 'empty') {
    pane.append(emptyCard());
    return;
  }
  if (translation.status === 'error') {
    const actions = [{ label: '重试', primary: true, onClick: () => retryTranslation() }];
    if (record.meta?.hasProvider && record.meta?.freeTranslation) {
      actions.push({ label: '改用免费翻译', onClick: () => retryTranslation({ engine: 'free' }) });
    } else {
      actions.push({ label: '打开设置', onClick: () => api.invoke('action:open-settings') });
    }
    const hint = String(translation.error || '').includes('免费翻译通道')
      ? '在设置中开启免费通道，或配置 AI 模型后重试。'
      : '检查模型配置后重试，或改用免费翻译。';
    pane.append(errorCard('翻译失败', translation.error, actions, hint));
    return;
  }
  if (translation.status === 'idle' || (translation.status === 'loading' && !translation.text)) {
    pane.append(loader('正在翻译…', ['w95', 'w80', 'w95', 'w60']));
    return;
  }

  if (translation.notice) pane.append(el('div', 'notice', translation.notice));
  if (shouldShowVisionHint()) pane.append(visionHint());
  const streaming = translation.status === 'loading';
  const domain = record.meta?.domain;
  const text = String(translation.text || '');
  if (domain === 'code' || /```/.test(text)) {
    const md = el('div', 'md code-content');
    renderMarkdown(md, text, streaming);
    pane.append(md);
  } else {
    const node = el('div', 'translation-text');
    if (isCjkTarget()) node.classList.add('cjk');
    renderMathText(node, text, streaming);
    if (streaming) node.append(el('span', 'caret'));
    pane.append(node);
  }
}

function ensureExplanation() {
  if (!record || !record.source) return;
  if (activePane !== 'explanation') return;
  if (record.explanation.status === 'idle' && !explainRequested) {
    requestExplain(false);
  }
}

function requestExplain(force = false) {
  if (!record || !record.source) return;
  if (record.explanation.status === 'loading' || localExplainLoading) return;
  explainRequested = true;
  localExplainLoading = true;
  record.explanation = {
    ...record.explanation,
    status: 'loading',
    text: '',
    error: '',
    notice: '',
    message: '',
  };
  renderExplanation();
  renderFooter();
  api.invoke('action:explain', { force }).catch((err) => {
    localExplainLoading = false;
    record.explanation.status = 'error';
    record.explanation.error = err.message;
    renderExplanation();
  });
}

function ctaCard({ title, text, primary, secondary, icon = 'spark' }) {
  const card = el('div', 'cta-card');
  card.append(iconBox('cta-icon', icon));
  card.append(el('h3', '', title));
  card.append(el('p', '', text));
  const row = el('div', 'card-actions');
  if (primary) {
    const button = el('button', 'btn-primary small', primary.label);
    button.addEventListener('click', primary.onClick);
    row.append(button);
  }
  if (secondary) {
    const button = el('button', 'btn-ghost small', secondary.label);
    button.addEventListener('click', secondary.onClick);
    row.append(button);
  }
  card.append(row);
  return card;
}

function renderExplanation() {
  const pane = $('pane-explanation');
  const explanation = record.explanation || {};
  const hasProvider = Boolean(record.meta?.hasProvider);
  pane.replaceChildren();

  if (!record.source) {
    pane.append(ctaCard({
      title: '没有可解释的内容',
      text: '重新框选一段文字、代码或公式，再让 AI 解释。',
      primary: { label: '重新框选', onClick: () => api.invoke('action:select') },
    }));
    return;
  }

  if (explanation.notice) pane.append(el('div', 'notice', explanation.notice));

  if ((localExplainLoading || explanation.status === 'loading') && !explanation.text) {
    pane.append(loader(hasProvider ? '正在理解这段内容…' : '正在准备解释…'));
    return;
  }

  if (explanation.status === 'unavailable') {
    pane.append(ctaCard({
      title: '解释由 AI 生成',
      text: explanation.message || '接入 DeepSeek、通义千问等模型后，可以获得语境解释、代码讲解与公式推导。',
      primary: hasProvider
        ? { label: '开始解释', onClick: () => requestExplain(true) }
        : { label: '配置 AI 模型', onClick: () => api.invoke('action:open-settings') },
      secondary: hasProvider
        ? { label: '配置模型', onClick: () => api.invoke('action:open-settings') }
        : { label: '重新检查', onClick: () => requestExplain(true) },
      icon: 'key',
    }));
    return;
  }

  if (explanation.status === 'error') {
    pane.append(errorCard('解释失败', explanation.error, [
      { label: '重试', primary: true, onClick: () => requestExplain(true) },
      { label: '打开设置', onClick: () => api.invoke('action:open-settings') },
    ], '检查模型配置后重试，或先在设置中测试连接。'));
    return;
  }

  if (explanation.status === 'idle') {
    pane.append(ctaCard({
      title: hasProvider ? '让 AI 解释这段内容' : '配置模型后可以解释内容',
      text: hasProvider
        ? '解释代码逻辑、公式推导、术语背景与上下文含义，结果会保留在当前窗口。'
        : '翻译已经可用；接入 AI 模型后，可获得语境解释、代码讲解与公式推导。',
      primary: hasProvider
        ? { label: '开始解释', onClick: () => requestExplain(false) }
        : { label: '配置 AI 模型', onClick: () => api.invoke('action:open-settings') },
      secondary: hasProvider
        ? { label: '配置模型', onClick: () => api.invoke('action:open-settings') }
        : { label: '重新检查', onClick: () => requestExplain(true) },
      icon: hasProvider ? 'spark' : 'key',
    }));
    return;
  }

  const streaming = explanation.status === 'loading';
  if (!explanation.text) {
    pane.append(el('div', 'md', ''));
  } else {
    const md = el('div', 'md');
    renderMarkdown(md, explanation.text, streaming);
    pane.append(md);
  }
}

function relatedSourceLabel(related) {
  if (related?.source === 'ai') return 'AI 提取';
  if (related?.source === 'rules') return '本地提取';
  return '相关知识';
}

function ensureRelated() {
  if (!record || activePane !== 'related') return;
  if (!record.source || record.translation?.status !== 'done') return;
  if (record.related?.status === 'idle' && !relatedRequested) {
    requestRelated(false);
  }
}

function requestRelated(force = false) {
  if (!record || !record.source) return;
  if (record.translation?.status !== 'done') return;
  relatedRequested = true;
  record.related = {
    ...(record.related || {}),
    status: 'loading',
    keywords: [],
    links: [],
    notice: '',
    error: '',
  };
  renderRelated();
  renderFooter();
  api.invoke('action:related', { force }).catch((err) => {
    relatedRequested = false;
    record.related = {
      ...(record.related || {}),
      status: 'error',
      error: err.message,
    };
    renderRelated();
    renderFooter();
  });
}

async function openSearch(url) {
  try {
    const result = await api.invoke('search:open', url);
    if (result?.ok) cardToast('已在默认浏览器打开');
    else cardToast(result?.error || '打开链接失败');
  } catch {
    cardToast('打开链接失败');
  }
}

function renderRelated() {
  const pane = $('pane-related');
  const related = record?.related || {};
  pane.replaceChildren();

  if (!record?.source) {
    pane.append(ctaCard({
      title: '没有可搜索的内容',
      text: '重新框选一段文字、代码或公式，再提取相关知识与搜索链接。',
      primary: { label: '重新框选', onClick: () => api.invoke('action:select') },
      icon: 'globe',
    }));
    return;
  }

  if (record.translation?.status !== 'done') {
    pane.append(loader('翻译完成后生成相关知识…', ['w70', 'w50']));
    return;
  }

  if (related.status === 'loading' || related.status === 'idle') {
    pane.append(loader('正在提取关键词…', ['w80', 'w65', 'w45']));
    return;
  }

  if (related.status === 'error') {
    pane.append(errorCard('相关知识生成失败', related.error || '暂时无法生成搜索关键词。', [
      { label: '重试', primary: true, onClick: () => requestRelated(true) },
    ], '会先重试 AI 关键词，失败时自动回退本地提取。'));
    return;
  }

  const head = el('div', 'related-head');
  head.append(iconBox('related-icon', 'globe'));
  const headText = el('div', 'related-head-text');
  headText.append(el('h3', '', '相关知识'));
  headText.append(el('p', '', '根据原文、译文与内容类型提取'));
  head.append(headText);
  head.append(el('span', 'related-source', relatedSourceLabel(related)));
  pane.append(head);

  if (related.notice) pane.append(el('div', 'notice', related.notice));

  const keywords = Array.isArray(related.keywords) ? related.keywords : [];
  const links = Array.isArray(related.links) ? related.links : [];

  if (keywords.length) {
    const section = el('div', 'related-section');
    const headRow = el('div', 'related-section-head');
    headRow.append(el('span', 'related-label', '搜索关键词'));
    const copyAll = el('button', 'related-mini', '复制全部');
    copyAll.addEventListener('click', () => copyText(keywords.join(' '), '已复制全部关键词'));
    headRow.append(copyAll);
    section.append(headRow);
    const chips = el('div', 'related-keywords');
    for (const keyword of keywords) {
      const chip = el('button', 'related-keyword', keyword);
      chip.type = 'button';
      chip.title = '点击复制关键词';
      chip.addEventListener('click', () => copyText(keyword, '已复制关键词'));
      chips.append(chip);
    }
    section.append(chips);
    pane.append(section);
  }

  if (links.length) {
    const section = el('div', 'related-section');
    const headRow = el('div', 'related-section-head');
    headRow.append(el('span', 'related-label', '搜索站点'));
    headRow.append(el('span', 'related-hint', '默认浏览器打开'));
    section.append(headRow);
    const list = el('div', 'related-links');
    for (const link of links) {
      const card = el('button', 'related-link');
      card.type = 'button';
      card.title = `打开 ${link.site} 搜索：${link.query}`;
      const mark = el('span', 'related-site-mark', link.key === 'baidu' ? '百' : (link.site || '?').slice(0, 1));
      const main = el('span', 'related-link-main');
      main.append(el('strong', '', link.site || ''));
      main.append(el('span', 'related-link-meta', `${link.host || ''} · ${link.description || ''}`));
      main.append(el('span', 'related-link-query', link.query || ''));
      const external = el('span', 'related-external');
      external.innerHTML = ICONS.external;
      card.append(mark, main, external);
      card.addEventListener('click', () => openSearch(link.url));
      list.append(card);
    }
    section.append(list);
    pane.append(section);
  }

  if (!keywords.length && !links.length) {
    const empty = el('div', 'related-empty');
    empty.append(el('p', '', '没有提取到合适的搜索关键词。'));
    const retry = el('button', 'btn-ghost small', '重新提取');
    retry.addEventListener('click', () => requestRelated(true));
    empty.append(retry);
    pane.append(empty);
  } else {
    pane.append(el('div', 'related-note', related.source === 'ai'
      ? '关键词由 AI 提取，可能不完整，请结合原文判断。'
      : '关键词由本地规则提取，可能不完整，请结合原文判断。'));
  }
}

function renderFooter() {
  const translation = record.translation || {};
  const explanation = record.explanation || {};
  const related = record.related || {};
  const showExplanation = activePane === 'explanation';
  const showRelated = activePane === 'related';
  const status = showExplanation
    ? explanation.status
    : showRelated ? related.status : translation.status;
  const dot = $('foot-dot');
  let dotClass = 'off';
  if (status === 'loading' || status === 'ocr') dotClass = 'warn';
  else if (status === 'done') dotClass = '';
  else if (status === 'error') dotClass = 'error';
  else if (status === 'unavailable') dotClass = 'warn';
  dot.className = `dot ${dotClass}`.trim();

  let provider = translation.provider ||
    (translation.status === 'error' ? '未配置' : (record.engine === 'ai' ? 'AI 模型' : '免费翻译'));
  if (showExplanation) {
    provider = explanation.provider || (record.meta?.hasProvider ? 'AI 模型' : '未配置');
  } else if (showRelated) {
    provider = related.source === 'ai' ? 'AI 关键词' : related.source === 'rules' ? '本地提取' : '相关知识';
  }
  $('foot-provider').textContent = provider;
  $('foot-vision').classList.toggle('hidden', !record.meta?.visionUsed);

  const duration = record.meta?.durationMs;
  $('foot-time').textContent = !showExplanation && !showRelated && translation.status === 'done' && duration
    ? `· ${(duration / 1000).toFixed(duration < 1000 ? 2 : 1)}s`
    : '';
  const busy = translation.status === 'ocr' ||
    translation.status === 'loading' ||
    (showExplanation && (localExplainLoading || explanation.status === 'loading')) ||
    (showRelated && related.status === 'loading');
  $('progress').classList.toggle('hidden', !busy);
}

function schedule(field) {
  if (frames[field]) return;
  frames[field] = requestAnimationFrame(() => {
    frames[field] = null;
    if (!record) return;
    const scroller = $('content-scroll');
    const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 54;
    const top = scroller.scrollTop;
    if (field === 'translation') renderTranslation();
    else renderExplanation();
    renderFooter();
    const followStream = field === 'translation';
    if (followStream && nearBottom) scroller.scrollTop = scroller.scrollHeight;
    else scroller.scrollTop = top;
  });
}

function setPane(pane) {
  if (!record) return;
  activePane = pane;
  renderTabs();
  renderFooter();
  $('content-scroll').scrollTop = 0;
  if (pane === 'explanation') ensureExplanation();
  if (pane === 'related') ensureRelated();
}

function retryTranslation(options = {}) {
  if (!record) return;
  record.translation = {
    ...record.translation,
    status: 'loading',
    text: '',
    error: '',
    notice: '',
  };
  record.explanation = {
    status: 'idle',
    text: '',
    provider: '',
    error: '',
    notice: '',
    message: '',
  };
  record.related = {
    status: 'idle',
    keywords: [],
    links: [],
    source: '',
    notice: '',
    error: '',
    topic: '',
  };
  explainRequested = false;
  localExplainLoading = false;
  relatedRequested = false;
  renderAll();
  api.invoke('action:retranslate', options);
}

async function copyActive() {
  if (activePane === 'related') {
    const keywords = record?.related?.keywords || [];
    await copyText(keywords.join(' '), '已复制全部关键词');
    return;
  }
  const text = activePane === 'translation'
    ? (record?.translation?.text || '')
    : (record?.explanation?.text || '');
  await copyText(text);
}

function renderMarkdown(root, text, streaming) {
  root.classList.add('md');
  root.replaceChildren();
  const parts = String(text).split('```');
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const lines = part.split('\n');
      let lang = '';
      const firstLine = lines[0] ? lines[0].trim() : '';
      if (firstLine && CODE_LANGS.has(firstLine.toLowerCase())) {
        lang = firstLine;
        lines.shift();
      }
      const raw = lines.join('\n').replace(/\n$/, '');
      const block = el('div', 'code-block');
      const head = el('div', 'code-head');
      head.append(el('span', 'code-lang', lang || 'code'));
      const copy = el('button', 'code-copy', '复制');
      copy.addEventListener('click', () => copyText(raw, '代码已复制'));
      head.append(copy);
      block.append(head);
      const pre = el('pre');
      const code = el('code');
      code.textContent = raw;
      if (lang) code.className = `language-${LANG_ALIASES[lang.toLowerCase()] || lang.toLowerCase()}`;
      pre.append(code);
      block.append(pre);
      if (!streaming) highlightCode(code);
      root.append(block);
    } else {
      renderBlocks(root, part);
    }
  });
  if (streaming) root.append(el('span', 'caret'));
}

function highlightCode(code) {
  if (!window.hljs) return;
  try {
    if (/language-/.test(code.className)) {
      window.hljs.highlightElement(code);
    } else {
      const result = window.hljs.highlightAuto(code.textContent, [
        'javascript', 'typescript', 'python', 'bash', 'cpp', 'json', 'xml',
        'css', 'sql', 'go', 'java', 'csharp', 'rust',
      ]);
      code.innerHTML = result.value;
      code.classList.add('hljs');
    }
  } catch {}
}

function renderBlocks(root, text) {
  const lines = String(text).split('\n');
  let paragraph = [];
  let list = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = el('p');
    paragraph.forEach((line, index) => {
      if (index) p.append(el('br'));
      p.append(inlineNodes(line));
    });
    root.append(p);
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      root.append(list.node);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    const displayMath = line.match(/^\s*\$\$(.+?)\$\$\s*$/) || line.match(/^\s*\\\[(.+?)\\\]\s*$/);
    if (displayMath) {
      flushParagraph();
      flushList();
      const block = el('div', 'math-block');
      renderKatex(block, displayMath[1], true, line);
      root.append(block);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(4, heading[1].length + 1);
      const node = el(`h${level}`);
      node.append(inlineNodes(heading[2]));
      root.append(node);
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      flushParagraph();
      flushList();
      root.append(el('hr'));
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      flushParagraph();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', node: el('ul') };
      }
      const li = el('li');
      li.append(inlineNodes(bullet[1]));
      list.node.append(li);
      continue;
    }
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) {
      flushParagraph();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', node: el('ol') };
      }
      const li = el('li');
      li.append(inlineNodes(numbered[1]));
      list.node.append(li);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      const node = el('blockquote');
      node.append(inlineNodes(quote[1]));
      root.append(node);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
}

function inlineNodes(text) {
  const fragment = document.createDocumentFragment();
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]|\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) fragment.append(document.createTextNode(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('**')) {
      fragment.append(el('strong', '', token.slice(2, -2)));
    } else if (token.startsWith('`')) {
      fragment.append(el('code', '', token.slice(1, -1)));
    } else if (token.startsWith('$') || token.startsWith('\\(') || token.startsWith('\\[')) {
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
      const span = el('span', display ? 'math-inline math-display-inline' : 'math-inline');
      renderKatex(span, body, false, token);
      fragment.append(span);
    } else {
      const close = token.indexOf(']');
      const label = token.slice(1, close);
      const url = token.slice(close + 2, -1);
      const link = el('a', '', label);
      link.href = '#';
      link.addEventListener('click', (event) => {
        event.preventDefault();
        api.invoke('action:open-external', url);
      });
      fragment.append(link);
    }
    last = match.index + token.length;
  }
  if (last < text.length) fragment.append(document.createTextNode(text.slice(last)));
  return fragment;
}

function renderKatex(target, tex, display, raw) {
  try {
    if (!window.katex) throw new Error('katex missing');
    const html = window.katex.renderToString(tex, {
      displayMode: Boolean(display),
      throwOnError: true,
      trust: false,
      strict: false,
      output: 'html',
    });
    target.innerHTML = html;
  } catch {
    target.textContent = raw || (display ? `$$${tex}$$` : `$${tex}$`);
    target.classList.add('math-fallback');
  }
}

function mathSegments(text) {
  const pattern = /(\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\])/g;
  const segments = [];
  let last = 0;
  let match;
  while ((match = pattern.exec(text))) {
    if (match.index > last) {
      segments.push({ type: 'text', value: text.slice(last, match.index) });
    }
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

function renderMathText(container, text, streaming) {
  if (streaming) {
    container.textContent = text;
    return;
  }
  const segments = mathSegments(text);
  if (segments.length === 1 && segments[0].type === 'text') {
    container.textContent = text;
    return;
  }
  for (const segment of segments) {
    if (segment.type === 'text') {
      container.append(document.createTextNode(segment.value));
      continue;
    }
    const target = el(segment.display ? 'div' : 'span', segment.display ? 'math-block' : 'math-inline');
    renderKatex(target, segment.value, segment.display, segment.raw);
    container.append(target);
  }
}

function bindEvents() {
  $('close-btn').addEventListener('click', () => api.invoke('action:close-result'));
  $('pin-btn').addEventListener('click', async () => {
    const res = await api.invoke('result:pin');
    pinned = Boolean(res?.pinned);
    $('pin-btn').classList.toggle('pinned', pinned);
    $('pin-btn').title = pinned ? '取消置顶' : '置顶窗口';
    cardToast(pinned ? '已置顶' : '取消置顶');
  });
  $('copy-btn').addEventListener('click', copyActive);
  $('retry-btn').addEventListener('click', () => retryTranslation());
  $('source-toggle').addEventListener('click', () => {
    sourceExpanded = !sourceExpanded;
    $('source-toggle').textContent = sourceExpanded ? '收起' : '展开';
    renderSource();
  });
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => setPane(tab.dataset.pane));
  }
  $('domain-select').addEventListener('change', (event) => {
    if (!record) return;
    const mode = event.target.value;
    record.meta = {
      ...(record.meta || {}),
      domainMode: mode,
      domain: mode === 'auto' ? (record.meta?.detectedDomain || 'general') : mode,
      domainLabel: domainLabel(mode === 'auto' ? (record.meta?.detectedDomain || 'general') : mode),
    };
    record.translation = {
      ...record.translation,
      status: 'loading',
      text: '',
      error: '',
      notice: '',
    };
    record.explanation = {
      status: 'idle',
      text: '',
      provider: '',
      error: '',
      notice: '',
      message: '',
    };
    record.related = {
      status: 'idle',
      keywords: [],
      links: [],
      source: '',
      notice: '',
      error: '',
      topic: '',
    };
    explainRequested = true;
    localExplainLoading = false;
    relatedRequested = false;
    renderAll();
    cardToast(`内容类型：${mode === 'auto' ? '自动' : domainLabel(mode)} · 正在重译`);
    api.invoke('action:set-domain', { domain: mode });
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      api.invoke('action:close-result');
    }
  });
  api.on('result:show', (next) => show(next));
  api.on('result:state', (next) => updateRecord(next));
  api.on('result:delta', ({ field, delta }) => {
    if (!record || !delta) return;
    if (field === 'translation') {
      record.translation.text = (record.translation.text || '') + delta;
      record.translation.status = 'loading';
      schedule('translation');
    } else if (field === 'explanation') {
      record.explanation.text = (record.explanation.text || '') + delta;
      record.explanation.status = 'loading';
      schedule('explanation');
    }
    renderFooter();
  });
}

(async function init() {
  bindEvents();
  try {
    const current = await api.invoke('result:get');
    if (current) show(current);
  } catch {}
})();
