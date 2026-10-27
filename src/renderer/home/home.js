const api = window.screenlens;
const $ = (id) => document.getElementById(id);

const PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  'qwen-vl': { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  custom: null,
};

const LANG_LABEL = { 'zh-CN': '中文', en: 'EN', ja: '日文', ko: '韩文', ru: 'RU', auto: 'AUTO' };
const TAB_LABEL = { home: '首页', history: '历史', settings: '设置' };

let state = null;
let currentTab = 'home';
let searchQuery = '';
let recording = null;
let keySaveTimer = null;
let pendingSelect = false;
let pendingRealtime = false;
let suppressSelectClick = 0;
let suppressRealtimeClick = 0;
let suppressAudioClick = 0;
let pendingAudio = false;
let hoverFocusTimer = null;
let realtimeSawSelecting = false;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(title, body, kind = 'info') {
  const root = $('toast-root');
  const toast = el('div', `toast ${kind}`);
  toast.append(el('strong', '', title));
  if (body) toast.append(el('p', '', body));
  root.append(toast);
  setTimeout(() => {
    toast.style.transition = 'opacity .25s ease, transform .25s ease';
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(6px)';
    setTimeout(() => toast.remove(), 260);
  }, 3600);
}

function formatTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.getTime() >= startOfToday) return time;
  if (date.getTime() >= startOfToday - 86400000) return `昨天 ${time}`;
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

function formatAccel(accel) {
  return String(accel || '')
    .replace(/Control/g, 'Ctrl')
    .replace(/Super/g, 'Win')
    .split('+')
    .filter(Boolean)
    .join(' + ');
}

function langLabel(lang) {
  return LANG_LABEL[lang] || String(lang || '').toUpperCase();
}

async function refreshState() {
  state = await api.invoke('app:state');
  render();
}

function render() {
  if (!state) return;
  renderStatus();
  renderHome();
  renderHistory();
  renderSettingsMeta();
  if (currentTab === 'settings') syncSettingsForm(false);
}

function renderStatus() {
  const settings = state.settings;
  const ocr = state.ocr;
  const ocrDot = $('ocr-dot');
  ocrDot.className = `dot ${ocr.status === 'ready' ? '' : ocr.status === 'error' ? 'error' : 'warn'}`;
  $('ocr-label').textContent = ocr.status === 'ready'
    ? '本地 OCR 就绪'
    : ocr.status === 'error'
      ? 'OCR 不可用'
      : 'OCR 启动中';
  $('ocr-sub').textContent = ocr.status === 'ready'
    ? (ocr.languages || []).map((l) => (l.startsWith('zh') ? '中文' : l.startsWith('en') ? 'English' : l)).join(' · ')
    : ocr.status === 'error'
      ? '点击下方可重试'
      : 'Windows 本地引擎';
  $('ocr-retry').classList.toggle('hidden', ocr.status !== 'error');

  $('hero-ocr-dot').className = `dot ${ocr.status === 'ready' ? '' : ocr.status === 'error' ? 'error' : 'warn'}`;
  $('stat-ocr').textContent = ocr.status === 'error' ? '引擎异常' : 'Windows OCR';
  $('stat-ocr-sub').textContent = ocr.status === 'ready'
    ? `${(ocr.languages || []).map((l) => (l.startsWith('zh') ? '中文' : l.startsWith('en') ? 'English' : l)).join(' · ')} · 离线`
    : ocr.status === 'error'
      ? (ocr.error || '初始化失败').slice(0, 42)
      : '正在启动…';

  const provider = state.provider;
  const freeOn = settings.freeTranslation !== false;
  $('model-dot').className = `dot ${provider.hasProvider ? '' : (freeOn ? 'off' : 'warn')}`;
  $('model-label').textContent = provider.hasProvider
    ? provider.label
    : (freeOn ? '免费翻译' : '未配置模型');
  $('model-sub').textContent = provider.hasProvider
    ? `${provider.model || 'AI 模型'} · 已配置`
    : (freeOn ? '配置模型可解释内容' : '免费通道已关闭');
  $('hero-provider').textContent = provider.hasProvider
    ? `${provider.label} · ${provider.model}`
    : (freeOn ? '免费翻译通道' : '未配置翻译服务');
  $('stat-provider').textContent = provider.hasProvider
    ? provider.label
    : (freeOn ? '免费通道' : '未配置');
  $('stat-provider-sub').textContent = provider.hasProvider
    ? 'AI 翻译 · 语境解释已开启'
    : (freeOn ? '可在设置中接入大模型' : '免费通道已关闭');
  $('provider-banner').classList.toggle('hidden', provider.hasProvider);
  $('provider-banner-title').textContent = freeOn ? '解锁语境解释' : '翻译与解释需要模型';
  $('provider-banner-text').textContent = freeOn
    ? '接入 DeepSeek、通义千问等模型，解释代码、公式与科普内容。翻译可先用免费通道。'
    : '免费通道已关闭。接入模型后即可恢复翻译，并获得代码、公式与科普解释。';

  const realtime = state.realtime;
  if (state.selecting) {
    pendingSelect = false;
    pendingRealtime = false;
    realtimeSawSelecting = true;
  } else if (realtimeSawSelecting && !realtime.active) {
    realtimeSawSelecting = false;
  }
  if (realtime.active) {
    pendingRealtime = false;
    realtimeSawSelecting = false;
  }
  $('select-label').textContent = state.selecting
    ? '框选中…'
    : (pendingSelect ? '准备中…' : '截屏翻译');
  $('btn-select').disabled = Boolean(state.selecting || pendingSelect);
  $('realtime-label').textContent = realtime.active
    ? '停止字幕'
    : (pendingRealtime ? '启动中…' : '实时字幕');
  $('btn-realtime').disabled = !realtime.active && pendingRealtime;
  $('stat-realtime').textContent = realtime.active ? '运行中' : '未开启';
  $('quick-realtime').textContent = realtime.active ? '停止 →' : '开启 →';

  const audio = state.audio || {};
  if (audio.active) pendingAudio = false;
  $('audio-label').textContent = audio.active ? '停止音频' : (pendingAudio ? '启动中…' : '音频字幕');
  $('btn-audio').disabled = pendingAudio && !audio.active;
  $('btn-audio').title = audio.ready
    ? `${audio.name || '本地 Whisper'} · 系统声音/麦克风`
    : (audio.reason || '本地 Whisper 模型不可用');

  $('hero-hotkey').textContent = formatAccel(settings.hotkeys.select).replace(/ \+ /g, ' ');
  $('realtime-hotkey').textContent = formatAccel(settings.hotkeys.realtime).replace(/ \+ /g, ' ');

  const quickTarget = $('quick-target');
  if (document.activeElement !== quickTarget) quickTarget.value = settings.targetLang;

  const count = state.history.length;
  $('history-count').textContent = String(count);
  $('history-count').classList.toggle('hidden', count === 0);
  $('version').textContent = `v${state.version}`;
  $('about-version').textContent = `v${state.version}`;
  $('about-version-chip').textContent = `v${state.version}`;
  $('data-dir').textContent = state.dataDir;
  $('data-dir').title = state.dataDir;

  if (!recording) {
    $('hotkey-select').value = formatAccel(settings.hotkeys.select);
    $('hotkey-realtime').value = formatAccel(settings.hotkeys.realtime);
  }

  const messages = state.hotkeys?.messages || [];
  const bothReady = Boolean(state.hotkeys?.select && state.hotkeys?.realtime);
  const statusNode = $('hotkey-status');
  if (recording) {
    statusNode.textContent = '正在录制新的快捷键…按 Esc 取消';
    statusNode.classList.remove('error', 'warn');
  } else if (messages.length) {
    statusNode.textContent = messages
      .join('；')
      .replace(/Control/g, 'Ctrl')
      .replace(/Super/g, 'Win');
    statusNode.classList.toggle('error', !bothReady);
    statusNode.classList.toggle('warn', bothReady);
  } else if (bothReady) {
    statusNode.textContent = '快捷键已生效。若与游戏或输入法冲突，可换一个组合。';
    statusNode.classList.remove('error', 'warn');
  } else {
    statusNode.textContent = '快捷键尚未注册。';
    statusNode.classList.add('error');
    statusNode.classList.remove('warn');
  }
}

function renderHome() {
  const grid = $('recent-grid');
  grid.replaceChildren();
  const items = state.history.slice(0, 6);
  if (!items.length) {
    const empty = el('div', 'recent-empty');
    const icon = el('div', 'recent-empty-icon');
    icon.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 8V5.8C4 4.8 4.8 4 5.8 4H8M16 4h2.2c1 0 1.8.8 1.8 1.8V8M20 16v2.2c0 1-.8 1.8-1.8 1.8H16M8 20H5.8c-1 0-1.8-.8-1.8-1.8V16"/><path d="M9 12h6"/></svg>';
    const copy = el('div', '');
    copy.append(el('strong', '', '第一条翻译，从框选开始'));
    copy.append(el('p', '', '按下 ' + formatAccel(state.settings.hotkeys.select) + '，框住屏幕上的任意文字。'));
    const button = el('button', 'btn-small accent', '立即框选');
    button.addEventListener('click', triggerSelect);
    empty.append(icon, copy, button);
    grid.append(empty);
    return;
  }
  for (const item of items) {
    const card = el('button', 'recent-card');
    const thumb = el('div', 'recent-thumb');
    if (item.thumbUrl) {
      thumb.style.backgroundImage = `url("${item.thumbUrl}")`;
    } else {
      thumb.classList.add('placeholder');
    }
    const lang = el('span', 'recent-lang', `${langLabel(item.sourceLang)} → ${langLabel(item.targetLang)}`);
    thumb.append(lang);
    const body = el('div', 'recent-body');
    body.append(el('div', 'recent-source', item.source.replace(/\s+/g, ' ').slice(0, 80) || '未识别到文字'));
    body.append(el('div', 'recent-translation', item.translation || '（暂无译文）'));
    const meta = el('div', 'recent-meta');
    const left = el('span', '');
    const dot = el('span', 'recent-dot');
    left.append(dot, document.createTextNode(formatTime(item.createdAt)));
    meta.append(left, el('span', '', item.engine === 'ai' ? 'AI' : 'FREE'));
    body.append(meta);
    card.append(thumb, body);
    card.addEventListener('click', () => api.invoke('action:open-history', item.id));
    grid.append(card);
  }
}

function renderHistory() {
  const list = $('history-list');
  const empty = $('history-empty');
  list.replaceChildren();
  const keyword = searchQuery.trim().toLowerCase();
  const items = keyword
    ? state.history.filter((item) => (
      (item.source || '').toLowerCase().includes(keyword) ||
      (item.translation || '').toLowerCase().includes(keyword)
    ))
    : state.history;

  $('history-sub').textContent = state.history.length
    ? `${state.history.length} 条记录 · 截图与文本仅保存在本机`
    : '最近识别与翻译的内容';

  if (!items.length) {
    empty.classList.remove('hidden');
    if (state.history.length && keyword) {
      $('history-empty-title').textContent = '没有找到匹配记录';
      $('history-empty-text').textContent = '换个关键词，或清空搜索框再试试。';
      $('history-empty-action').classList.add('hidden');
    } else {
      $('history-empty-title').textContent = '还没有翻译记录';
      $('history-empty-text').textContent = '按下快捷键框选屏幕上的任意文字，结果会自动保存到这里。';
      $('history-empty-action').classList.remove('hidden');
    }
    return;
  }
  empty.classList.add('hidden');

  for (const item of items) {
    const row = el('div', 'history-item');
    const thumb = el('div', 'history-thumb');
    if (item.thumbUrl) {
      thumb.style.backgroundImage = `url("${item.thumbUrl}")`;
    } else {
      thumb.classList.add('placeholder');
    }
    const main = el('div', 'history-main');
    main.append(el('div', 'history-source', (item.source || '').replace(/\s+/g, ' ').slice(0, 160)));
    main.append(el('div', 'history-translation', item.translation || '（暂无译文）'));
    const side = el('div', 'history-side');
    side.append(el('span', 'chip', `${langLabel(item.sourceLang)} → ${langLabel(item.targetLang)}`));
    side.append(el('span', 'history-time', formatTime(item.createdAt)));
    const del = el('button', 'icon-btn danger history-delete');
    del.title = '删除这条记录';
    del.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7h16M9 7V4.8h6V7M6.5 7l.8 12.2h9.4L17.5 7M10 11v5M14 11v5"/></svg>';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      api.invoke('action:remove-history', item.id);
    });
    side.append(del);
    row.append(thumb, main, side);
    row.addEventListener('click', () => api.invoke('action:open-history', item.id));
    list.append(row);
  }
}

function detectPreset(baseUrl, model) {
  const value = String(baseUrl || '');
  const modelValue = String(model || '');
  const matches = [];
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (!preset || !value) continue;
    try {
      if (new URL(value).host === new URL(preset.baseUrl).host) matches.push([key, preset]);
    } catch {}
  }
  const exact = matches.find(([, preset]) => preset.model === modelValue);
  return exact ? exact[0] : (matches[0]?.[0] || 'custom');
}

function syncSettingsForm(force) {
  if (!state) return;
  const s = state.settings;
  const setValue = (id, value, eventName) => {
    const node = $(id);
    if (!node) return;
    if (!force && (document.activeElement === node || recording)) return;
    node.value = value;
  };
  setValue('setting-target', s.targetLang);
  setValue('setting-domain', s.contentDomain);
  setValue('setting-engine', s.translateEngine);
  setValue('setting-explain-lang', s.explanationLanguage);
  setValue('provider-preset', detectPreset(s.provider.baseUrl, s.provider.model), 'provider');
  setValue('provider-base', s.provider.baseUrl, 'provider');
  setValue('provider-model', s.provider.model, 'provider');

  const smart = $('setting-smart-swap');
  if (force || document.activeElement !== smart) smart.checked = s.smartSwap;
  const free = $('free-translation');
  if (force || document.activeElement !== free) free.checked = s.freeTranslation !== false;
  const vision = $('vision-enabled');
  if (force || document.activeElement !== vision) vision.checked = Boolean(s.vision?.enabled);

  $('provider-state').textContent = state.provider.hasProvider ? '已配置' : '未配置';
  $('provider-state').classList.toggle('mint', state.provider.hasProvider);

  const keyInput = $('provider-key');
  keyInput.placeholder = s.provider.hasApiKey
    ? `已保存 ${s.provider.keyHint}，输入新 Key 可替换`
    : (state.provider.hasProvider
      ? '本地模型无需 Key'
      : '粘贴 API Key，仅保存在本机');

  const hint = $('engine-hint');
  if (!s.freeTranslation && !state.provider.hasProvider) {
    hint.textContent = '免费通道已关闭且未配置模型，翻译不可用';
  } else if (!s.freeTranslation && s.translateEngine === 'free') {
    hint.textContent = '免费通道已关闭，请在引擎中选择 AI 或重新开启';
  } else if (s.translateEngine === 'free') {
    hint.textContent = '始终使用免费翻译通道';
  } else if (s.translateEngine === 'ai') {
    hint.textContent = state.provider.hasProvider ? '使用已配置的 AI 模型翻译' : '未配置模型，将回退免费通道';
  } else {
    hint.textContent = state.provider.hasProvider ? '自动使用 AI 模型润色翻译' : '自动使用免费通道';
  }

  const visionHint = $('vision-hint');
  if (s.vision?.enabled) {
    visionHint.textContent = state.provider.hasProvider
      ? '已开启：选区截图会发送给模型服务；不支持视觉的模型会自动回退文本模式。'
      : '已开启读图，但尚未配置模型；请先配置支持图片输入的视觉模型。';
    visionHint.classList.add('warning');
  } else {
    visionHint.textContent = '开启后，选区截图会离开本机发送给模型服务。不支持视觉的模型会自动回退到文本模式；实时字幕不使用读图。';
    visionHint.classList.add('warning');
  }

  const interval = $('realtime-interval');
  if (force || document.activeElement !== interval) interval.value = s.realtime.intervalMs;
  $('realtime-interval-value').textContent = `${(s.realtime.intervalMs / 1000).toFixed(1)} 秒`;
  const font = $('realtime-font');
  if (force || document.activeElement !== font) font.value = s.realtime.fontSize;
  $('realtime-font-value').textContent = `${s.realtime.fontSize} px`;
  const opacity = $('realtime-opacity');
  if (force || document.activeElement !== opacity) opacity.value = Math.round(s.realtime.opacity * 100);
  $('realtime-opacity-value').textContent = `${Math.round(s.realtime.opacity * 100)}%`;
  setValue('realtime-engine', s.realtime.engine);
  setValue('realtime-lines', String(s.realtime.maxLines));
  setValue('audio-source', s.audio.source);
  setValue('audio-language', s.audio.language);
  const audioInfo = state.audio || {};
  const audioStatus = $('audio-model-status');
  if (audioStatus) {
    audioStatus.textContent = audioInfo.ready ? '已就绪' : '未安装';
    audioStatus.classList.toggle('mint', Boolean(audioInfo.ready));
  }
  const audioDetail = $('audio-model-detail');
  if (audioDetail) {
    audioDetail.textContent = audioInfo.ready
      ? `${audioInfo.name || 'Whisper'} · 约为每 6 秒更新一次`
      : (audioInfo.reason || '未找到本地 Whisper 模型');
  }

  const launch = $('launch-at-login');
  if (force || document.activeElement !== launch) launch.checked = s.launchAtLogin;
  const paused = $('history-paused');
  if (force || document.activeElement !== paused) paused.checked = s.historyPaused;
  setValue('history-limit', String(s.historyLimit));
}

function renderSettingsMeta() {
  if (!state) return;
  $('provider-state').textContent = state.provider.hasProvider ? '已配置' : '未配置';
  $('provider-state').classList.toggle('mint', state.provider.hasProvider);
}

async function saveSettings(patch, toast) {
  try {
    const res = await api.invoke('settings:update', patch);
    if (res?.state) {
      state = res.state;
      render();
    }
    if (toast) showToast(toast, '');
  } catch (err) {
    showToast('保存失败', err.message, 'error');
  }
}

function switchTab(tab) {
  if (!TAB_LABEL[tab]) return;
  currentTab = tab;
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const page of document.querySelectorAll('.page')) {
    page.classList.toggle('active', page.id === `page-${tab}`);
  }
  $('titlebar-label').textContent = TAB_LABEL[tab];
  $('page-scroll').scrollTop = 0;
  if (tab === 'settings') syncSettingsForm(true);
  if (tab === 'history') renderHistory();
}

function openProviderSettings() {
  switchTab('settings');
  setTimeout(() => {
    const field = $('provider-base');
    const card = field?.closest('.setting-card');
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.animate(
      [
        { boxShadow: '0 0 0 0 rgba(139,243,208,0)' },
        { boxShadow: '0 0 0 4px rgba(139,243,208,.24)' },
        { boxShadow: '0 0 0 0 rgba(139,243,208,0)' },
      ],
      { duration: 1500, easing: 'ease-out' },
    );
    $('provider-key').focus();
  }, 80);
}

let onboardingOpen = false;

function showOnboarding() {
  $('onboarding').classList.remove('hidden');
  onboardingOpen = true;
}

function closeOnboarding({ config = false } = {}) {
  $('onboarding').classList.add('hidden');
  onboardingOpen = false;
  if (state && !state.settings.onboarded) {
    saveSettings({ onboarded: true });
  }
  if (config) openProviderSettings();
}

function triggerSelect() {
  if (pendingSelect || state?.selecting) {
    showToast('正在准备框选', '框选窗口即将出现，请勿重复点击', 'warn');
    return;
  }
  pendingSelect = true;
  $('btn-select').disabled = true;
  $('select-label').textContent = '准备中…';
  api.invoke('action:select').then((res) => {
    if (!res || !res.ok) {
      pendingSelect = false;
      $('btn-select').disabled = Boolean(state?.selecting);
      $('select-label').textContent = state?.selecting ? '框选中…' : '截屏翻译';
      showToast('无法开始框选', res?.reason === 'busy' ? '已有框选或实时字幕正在进行' : '请稍后重试', 'error');
      return;
    }
    setTimeout(() => {
      if (!pendingSelect) return;
      pendingSelect = false;
      $('btn-select').disabled = Boolean(state?.selecting);
      $('select-label').textContent = state?.selecting ? '框选中…' : '截屏翻译';
    }, 4500);
  }).catch((err) => {
    pendingSelect = false;
    $('btn-select').disabled = Boolean(state?.selecting);
    $('select-label').textContent = state?.selecting ? '框选中…' : '截屏翻译';
    showToast('无法开始框选', err.message || '请稍后重试', 'error');
  });
}

function toggleRealtime() {
  if (state?.realtime.active) {
    api.invoke('action:stop-realtime').catch(() => {});
    return;
  }
  if (pendingRealtime || state?.selecting) {
    showToast('正在准备中', '框选窗口即将出现，请勿重复点击', 'warn');
    return;
  }
  pendingRealtime = true;
  $('btn-realtime').disabled = true;
  $('realtime-label').textContent = '启动中…';
  api.invoke('action:realtime').then((res) => {
    if (!res || !res.ok) {
      pendingRealtime = false;
      $('btn-realtime').disabled = false;
      $('realtime-label').textContent = state?.realtime.active ? '停止字幕' : '实时字幕';
      showToast('无法启动实时字幕', res?.reason === 'busy' ? '已有框选或实时字幕正在进行' : '请稍后重试', 'error');
      return;
    }
    setTimeout(() => {
      if (!pendingRealtime) return;
      pendingRealtime = false;
      $('btn-realtime').disabled = false;
      $('realtime-label').textContent = state?.realtime.active ? '停止字幕' : '实时字幕';
    }, 6000);
  }).catch((err) => {
    pendingRealtime = false;
    $('btn-realtime').disabled = false;
    $('realtime-label').textContent = state?.realtime.active ? '停止字幕' : '实时字幕';
    showToast('无法启动实时字幕', err.message || '请稍后重试', 'error');
  });
}

async function toggleAudio() {
  const audioState = state?.audio || {};
  if (audioState.active) {
    api.invoke('action:audio').catch(() => {});
    return;
  }
  if (pendingAudio || state?.selecting || state?.realtime?.active) {
    showToast('正在准备中', state?.realtime?.active ? '请先停止实时字幕' : '框选窗口即将出现，请勿重复点击', 'warn');
    return;
  }
  if (!audioState.ready) {
    showToast('音频字幕不可用', audioState.reason || '本地 Whisper 模型未安装', 'error');
    return;
  }
  pendingAudio = true;
  $('btn-audio').disabled = true;
  $('audio-label').textContent = '启动中…';
  try {
    const res = await api.invoke('action:audio');
    if (!res || !res.ok) {
      pendingAudio = false;
      $('btn-audio').disabled = false;
      $('audio-label').textContent = state?.audio?.active ? '停止音频' : '音频字幕';
      showToast('无法启动音频字幕', res?.error || (res?.reason === 'busy' ? '请先停止实时字幕' : '请稍后重试'), 'error');
      return;
    }
    setTimeout(() => {
      if (!pendingAudio) return;
      pendingAudio = false;
      $('btn-audio').disabled = false;
      $('audio-label').textContent = state?.audio?.active ? '停止音频' : '音频字幕';
    }, 5000);
  } catch (err) {
    pendingAudio = false;
    $('btn-audio').disabled = false;
    $('audio-label').textContent = '音频字幕';
    showToast('无法启动音频字幕', err.message || '请稍后重试', 'error');
  }
}

function buildAccel(event) {
  const mods = [];
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.shiftKey) mods.push('Shift');
  if (event.metaKey) mods.push('Super');
  if (!event.ctrlKey && !event.altKey && !event.metaKey) {
    return { error: '快捷键至少需要 Ctrl、Alt 或 Win 之一' };
  }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return { pending: true };
  const named = {
    ' ': 'Space',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Escape: 'Escape',
    Enter: 'Enter',
    Tab: 'Tab',
    Backspace: 'Backspace',
    Delete: 'Delete',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
  };
  let key = named[event.key];
  if (!key && /^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  if (!key && /^Digit[0-9]$/.test(event.code)) key = event.code.slice(5);
  if (!key && /^F([1-9]|1[0-9]|2[0-4])$/.test(event.key)) key = event.key;
  if (!key && /^[a-zA-Z0-9]$/.test(event.key)) key = event.key.toUpperCase();
  if (!key) return { error: '这个按键不能用作快捷键' };
  return { accel: [...mods, key].join('+') };
}

function startRecording(which) {
  if (recording) cancelRecording();
  const input = which === 'select' ? $('hotkey-select') : $('hotkey-realtime');
  recording = { which, input, previous: input.value };
  input.classList.add('recording');
  input.value = '按下组合键…';
  input.focus();
}

function stopRecording(restore) {
  if (!recording) return;
  const { input, previous } = recording;
  input.classList.remove('recording');
  if (restore) input.value = previous;
  recording = null;
}

function cancelRecording() {
  stopRecording(true);
  if (state) syncSettingsForm(true);
}

async function applyHotkey(which, accel) {
  const res = await api.invoke('settings:update', { hotkeys: { [which]: accel } });
  if (res?.state) {
    state = res.state;
    render();
  }
  const messages = res?.hotkeys?.messages || [];
  if (messages.length) {
    showToast('快捷键未能注册', messages.join('；'), 'error');
  } else {
    showToast('快捷键已更新', `${formatAccel(accel)} 已生效`);
  }
}

function bindEvents() {
  for (const btn of document.querySelectorAll('.nav-item')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
  $('win-min').addEventListener('click', () => api.invoke('window:minimize'));
  $('win-max').addEventListener('click', () => api.invoke('window:maximize'));
  $('win-close').addEventListener('click', () => api.invoke('window:hide'));

  $('onboarding-start').addEventListener('click', () => closeOnboarding());
  $('onboarding-close').addEventListener('click', () => closeOnboarding());
  $('onboarding-backdrop').addEventListener('click', () => closeOnboarding());
  $('onboarding-config').addEventListener('click', () => closeOnboarding({ config: true }));

  $('history-empty-action').addEventListener('click', triggerSelect);
  $('quick-realtime').addEventListener('click', toggleRealtime);

  const selectBtn = $('btn-select');
  selectBtn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    suppressSelectClick = Date.now() + 700;
    triggerSelect();
  });
  selectBtn.addEventListener('click', () => {
    if (Date.now() < suppressSelectClick) return;
    triggerSelect();
  });

  const realtimeBtn = $('btn-realtime');
  realtimeBtn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    suppressRealtimeClick = Date.now() + 700;
    toggleRealtime();
  });
  realtimeBtn.addEventListener('click', () => {
    if (Date.now() < suppressRealtimeClick) return;
    toggleRealtime();
  });

  const audioBtn = $('btn-audio');
  audioBtn.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    suppressAudioClick = Date.now() + 700;
    toggleAudio();
  });
  audioBtn.addEventListener('click', () => {
    if (Date.now() < suppressAudioClick) return;
    toggleAudio();
  });

  $('audio-source').addEventListener('change', (event) => {
    saveSettings({ audio: { source: event.target.value } });
    if (state?.audio?.active) {
      showToast('音频来源已更改', '请停止后重新开启音频字幕以应用', 'warn');
    }
  });
  $('audio-language').addEventListener('change', (event) => {
    saveSettings({ audio: { language: event.target.value } });
  });

  $('ocr-retry').addEventListener('click', async () => {
    const btn = $('ocr-retry');
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = '正在重启…';
    try {
      const res = await api.invoke('action:restart-ocr');
      showToast(
        res?.ok ? 'OCR 正在重启' : 'OCR 重启失败',
        res?.ok ? '稍候即可继续使用' : (res?.error || '请稍后重试'),
        res?.ok ? 'info' : 'error',
      );
    } catch (err) {
      showToast('OCR 重启失败', err.message || '请稍后重试', 'error');
    }
    btn.disabled = false;
    btn.textContent = '重试 OCR';
  });

  document.addEventListener('mousemove', (event) => {
    const interactive = event.target instanceof Element
      && event.target.closest('button, a, input, select, textarea, [role="button"]');
    if (!interactive) {
      clearTimeout(hoverFocusTimer);
      hoverFocusTimer = null;
      return;
    }
    if (hoverFocusTimer) return;
    hoverFocusTimer = setTimeout(() => {
      hoverFocusTimer = null;
      api.send('window:focus');
    }, 120);
  });
  document.addEventListener('mouseleave', () => {
    clearTimeout(hoverFocusTimer);
    hoverFocusTimer = null;
  });
  $('hero-config').addEventListener('click', openProviderSettings);
  $('banner-config').addEventListener('click', openProviderSettings);
  $('see-history').addEventListener('click', () => switchTab('history'));

  $('quick-target').addEventListener('change', (event) => {
    saveSettings({ targetLang: event.target.value });
  });

  $('history-search').addEventListener('input', (event) => {
    searchQuery = event.target.value;
    renderHistory();
  });

  $('history-clear').addEventListener('click', () => api.invoke('action:clear-history'));
  $('clear-history').addEventListener('click', () => api.invoke('action:clear-history'));
  $('open-data').addEventListener('click', () => api.invoke('action:open-data'));

  $('replay-onboarding').addEventListener('click', showOnboarding);
  $('open-licenses').addEventListener('click', () => {
    const details = $('about-details');
    details.open = true;
    details.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  $('setting-target').addEventListener('change', (e) => saveSettings({ targetLang: e.target.value }));
  $('setting-smart-swap').addEventListener('change', (e) => saveSettings({ smartSwap: e.target.checked }));
  $('setting-engine').addEventListener('change', (e) => saveSettings({ translateEngine: e.target.value }));
  $('setting-domain').addEventListener('change', (e) => saveSettings({ contentDomain: e.target.value }));
  $('setting-explain-lang').addEventListener('change', (e) => saveSettings({ explanationLanguage: e.target.value }));

  $('free-translation').addEventListener('change', (e) => {
    saveSettings(
      { freeTranslation: e.target.checked },
      e.target.checked ? '免费翻译通道已开启' : '免费翻译通道已关闭',
    );
  });

  $('vision-enabled').addEventListener('change', (e) => {
    const enabled = e.target.checked;
    saveSettings(
      { vision: { enabled } },
      enabled ? '已开启多模态读图' : '已关闭多模态读图',
    );
    if (enabled && !state.provider.hasProvider) {
      showToast('还需要配置视觉模型', '多模态读图需要模型支持图片输入，否则会自动回退文本模式。');
    }
  });

  $('provider-preset').addEventListener('change', (event) => {
    const preset = PRESETS[event.target.value];
    if (!preset) return;
    $('provider-base').value = preset.baseUrl;
    $('provider-model').value = preset.model;
    saveSettings({ provider: { baseUrl: preset.baseUrl, model: preset.model } });
  });
  $('provider-base').addEventListener('change', () => {
    const baseUrl = $('provider-base').value.trim();
    const model = $('provider-model').value.trim();
    if (!baseUrl) return;
    saveSettings({ provider: { baseUrl, model } });
  });
  $('provider-model').addEventListener('change', () => {
    const model = $('provider-model').value.trim();
    if (!model) return;
    saveSettings({ provider: { model } });
  });
  $('provider-key').addEventListener('input', () => {
    clearTimeout(keySaveTimer);
    const value = $('provider-key').value.trim();
    if (!value) return;
    keySaveTimer = setTimeout(() => {
      saveSettings({ provider: { apiKey: value } });
    }, 900);
  });
  $('provider-key').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      $('provider-key').blur();
    }
  });
  $('provider-key').addEventListener('change', () => {
    const value = $('provider-key').value.trim();
    if (!value) return;
    saveSettings({ provider: { apiKey: value } }, 'API Key 已保存');
    $('provider-key').value = '';
    syncSettingsForm(true);
  });
  $('key-eye').addEventListener('click', () => {
    const input = $('provider-key');
    input.type = input.type === 'password' ? 'text' : 'password';
  });
  $('key-clear').addEventListener('click', () => {
    $('provider-key').value = '';
    saveSettings({ provider: { clearApiKey: true } }, '已清除 API Key');
  });
  $('provider-test').addEventListener('click', async () => {
    const button = $('provider-test');
    const result = $('provider-test-result');
    const baseUrl = $('provider-base').value.trim();
    const model = $('provider-model').value.trim();
    if (!baseUrl || !model) {
      result.textContent = '请先填写接口地址与模型名称';
      result.className = 'test-result err';
      return;
    }
    const draft = { baseUrl, model };
    const key = $('provider-key').value.trim();
    if (key) draft.apiKey = key;
    button.disabled = true;
    button.textContent = '测试中…';
    result.textContent = '';
    result.className = 'test-result';
    try {
      const res = await api.invoke('provider:test', draft);
      if (res.ok) {
        result.textContent = `连接成功 · ${res.ms}ms${res.reply ? ` · ${res.reply.replace(/\s+/g, ' ').slice(0, 24)}` : ''}`;
        result.className = 'test-result ok';
      } else {
        result.textContent = res.error || '连接失败';
        result.className = 'test-result err';
      }
    } catch (err) {
      result.textContent = err.message;
      result.className = 'test-result err';
    } finally {
      button.disabled = false;
      button.textContent = '测试连接';
    }
  });

  $('hotkey-select').addEventListener('click', () => startRecording('select'));
  $('hotkey-realtime').addEventListener('click', () => startRecording('realtime'));
  window.addEventListener('keydown', (event) => {
    if (!recording) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') {
      cancelRecording();
      return;
    }
    const build = buildAccel(event);
    if (build.pending) return;
    if (build.error) {
      showToast('快捷键无效', build.error, 'error');
      return;
    }
    const which = recording.which;
    stopRecording(true);
    applyHotkey(which, build.accel);
  });
  window.addEventListener('blur', () => {
    if (recording) cancelRecording();
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && onboardingOpen) {
      event.preventDefault();
      closeOnboarding();
    }
  });

  const saveRange = (id, build, label, format) => {
    const input = $(id);
    input.addEventListener('input', () => {
      const value = Number(input.value);
      label.textContent = format(value);
    });
    input.addEventListener('change', () => {
      const value = Number(input.value);
      saveSettings(build(value));
    });
  };
  saveRange(
    'realtime-interval',
    (v) => ({ realtime: { intervalMs: v } }),
    $('realtime-interval-value'),
    (v) => `${(v / 1000).toFixed(1)} 秒`,
  );
  saveRange(
    'realtime-font',
    (v) => ({ realtime: { fontSize: v } }),
    $('realtime-font-value'),
    (v) => `${v} px`,
  );
  saveRange(
    'realtime-opacity',
    (v) => ({ realtime: { opacity: v / 100 } }),
    $('realtime-opacity-value'),
    (v) => `${v}%`,
  );
  $('realtime-engine').addEventListener('change', (e) => saveSettings({ realtime: { engine: e.target.value } }));
  $('realtime-lines').addEventListener('change', (e) => saveSettings({ realtime: { maxLines: Number(e.target.value) } }));

  $('launch-at-login').addEventListener('change', (e) => {
    saveSettings({ launchAtLogin: e.target.checked }, e.target.checked ? '已开启开机启动' : '已关闭开机启动');
  });
  $('history-paused').addEventListener('change', (e) => saveSettings({ historyPaused: e.target.checked }));
  $('history-limit').addEventListener('change', (e) => saveSettings({ historyLimit: Number(e.target.value) }));
}

async function init() {
  bindEvents();
  await refreshState();
  if (state && !state.settings.onboarded) {
    setTimeout(showOnboarding, 350);
  }
  api.on('app:state-changed', (next) => {
    state = next;
    render();
  });
  api.on('app:navigate', (tab) => {
    if (onboardingOpen) closeOnboarding();
    switchTab(tab);
  });
  api.on('toast', ({ title, body }) => showToast(title, body, 'error'));
}

init().catch((err) => {
  showToast('界面加载失败', err.message, 'error');
});
