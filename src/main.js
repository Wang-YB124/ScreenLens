const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  Notification,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  net,
  protocol,
  screen,
  shell,
} = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const { SettingsStore } = require('./core/settings');
const { HistoryStore } = require('./core/history');
const { OcrService } = require('./core/ocr');
const { SessionManager } = require('./core/session');
const { RealtimeController } = require('./core/realtime');
const { AudioController } = require('./core/audio');
const { ResultWindow } = require('./windows/resultWindow');
const {
  resizeRealtimeWindow,
  updateRealtimeHitzone,
  startRealtimeDrag,
  moveRealtimeDrag,
  endRealtimeDrag,
  startRealtimeResize,
  moveRealtimeResize,
  endRealtimeResize,
  resetRealtimeSize,
} = require('./windows/realtimeWindow');
const { testProvider, providerLabel } = require('./core/llm');
const { isAllowedSearchUrl } = require('./core/search');

app.setName('ScreenLens');
app.setAppUserModelId('com.screenlens.app');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'shot',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const ROOT = path.join(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');
let settings;
let history;
let ocr;
let session;
let realtime;
let audio;
let resultWindow;
let homeWin = null;
let tray = null;
let quitting = false;
let hotkeyStatus = { select: false, realtime: false, messages: [] };
let ocrState = { status: 'starting', languages: [], error: '' };
let realtimeState = { active: false };
let audioState = { active: false };
let selecting = false;

const showHome = () => {
  if (!homeWin || homeWin.isDestroyed()) {
    createHomeWindow();
    return;
  }
  if (homeWin.isMinimized()) homeWin.restore();
  homeWin.show();
  homeWin.focus();
};

function iconPath(name = 'icon.png') {
  const file = path.join(ASSETS, name);
  return fs.existsSync(file) ? file : undefined;
}

function notify(title, body) {
  if (homeWin && !homeWin.isDestroyed() && homeWin.isVisible() && homeWin.isFocused()) {
    homeWin.webContents.send('toast', { title, body });
    return;
  }
  try {
    const notification = new Notification({
      title,
      body: body || '',
      icon: iconPath('icon.png'),
      silent: false,
    });
    notification.on('click', showHome);
    notification.show();
  } catch {}
}

function state() {
  const publicSettings = settings.getPublic();
  const audioInfo = audio ? audio.modelInfo() : { ready: false, name: 'Whisper', reason: '音频服务未初始化' };
  return {
    settings: publicSettings,
    history: history.list(),
    ocr: ocrState,
    hotkeys: hotkeyStatus,
    realtime: realtimeState,
    audio: {
      active: audioState.active,
      ready: audioInfo.ready,
      name: audioInfo.name,
      reason: audioInfo.reason,
    },
    selecting,
    provider: {
      label: providerLabel(publicSettings.provider),
      hasKey: publicSettings.provider.hasApiKey,
      hasProvider: settings.hasProvider(),
      model: publicSettings.provider.model,
    },
    version: app.getVersion(),
    dataDir: app.getPath('userData'),
    platform: process.platform,
  };
}

function broadcastState() {
  if (homeWin && !homeWin.isDestroyed()) {
    homeWin.webContents.send('app:state-changed', state());
  }
  updateTrayMenu();
}

function createHomeWindow() {
  const work = screen.getPrimaryDisplay().workArea;
  const width = Math.min(1320, work.width - 60);
  const height = Math.min(840, work.height - 60);
  const x = Math.round(work.x + (work.width - width) / 2);
  const y = Math.round(work.y + (work.height - height) / 2);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: 1040,
    minHeight: 680,
    frame: false,
    backgroundColor: '#0a0d13',
    show: false,
    title: 'ScreenLens 屏译',
    icon: iconPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'renderer', 'home', 'index.html'));
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  setTimeout(() => {
    if (!win.isDestroyed() && !process.argv.includes('--hidden') && !win.isVisible()) {
      win.show();
      win.focus();
    }
  }, 1500);
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('maximize', () => win.webContents.send('app:maximized', true));
  win.on('unmaximize', () => win.webContents.send('app:maximized', false));
  win.on('closed', () => {
    if (win.__hoverFocusTimer) clearInterval(win.__hoverFocusTimer);
    if (homeWin === win) homeWin = null;
  });
  let hoverSince = 0;
  win.__hoverFocusTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible() || win.isFocused()) {
      hoverSince = 0;
      return;
    }
    const cursor = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const inside = cursor.x >= bounds.x && cursor.x < bounds.x + bounds.width
      && cursor.y >= bounds.y && cursor.y < bounds.y + bounds.height;
    if (!inside) {
      hoverSince = 0;
      return;
    }
    if (!hoverSince) {
      hoverSince = Date.now();
      return;
    }
    if (Date.now() - hoverSince > 260) {
      hoverSince = 0;
      try { win.focus(); } catch {}
    }
  }, 80);
  homeWin = win;
  return win;
}

function navigate(tab) {
  showHome();
  if (homeWin && !homeWin.isDestroyed()) {
    homeWin.webContents.send('app:navigate', tab);
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const active = realtimeState.active;
  const audioOn = audioState.active;
  const hotkeys = settings.get().hotkeys;
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '框选翻译',
      accelerator: hotkeys.select || undefined,
      click: () => session.startSelection(),
    },
    {
      label: active ? '停止实时字幕' : '实时字幕',
      accelerator: hotkeys.realtime || undefined,
      click: () => (realtime.isActive() ? realtime.stop() : realtime.start()),
    },
    {
      label: audioOn ? '停止音频字幕' : '音频字幕（系统声音）',
      click: () => (audio.isActive() ? audio.stop() : audio.start()),
    },
    { type: 'separator' },
    { label: '打开主界面', click: showHome },
    { label: '设置', click: () => navigate('settings') },
    { type: 'separator' },
    {
      label: '退出 ScreenLens',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]));
  tray.setToolTip(active || audioOn ? 'ScreenLens · 字幕运行中' : 'ScreenLens 屏译');
}

function createTray() {
  const icon = nativeImage.createFromPath(iconPath('tray.png') || '');
  tray = new Tray(icon);
  tray.on('click', showHome);
  tray.on('double-click', showHome);
  updateTrayMenu();
}

function applyLoginItem(enabled) {
  try {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: process.execPath,
      args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden'],
    });
  } catch {}
}

function registerHotkeys() {
  const cfg = { ...settings.get().hotkeys };
  const original = { ...cfg };
  const messages = [];
  const results = { select: false, realtime: false };
  const fallbacks = {
    select: ['Control+Alt+Q', 'Control+Shift+X', 'Alt+Shift+X', 'Control+Alt+F'],
    realtime: ['Control+Alt+T', 'Control+Shift+R', 'Alt+Shift+R', 'Control+Alt+G'],
  };
  const actions = {
    select: () => {
      if (selecting) return;
      session.startSelection();
    },
    realtime: () => {
      if (realtime.isActive()) realtime.stop();
      else realtime.start();
    },
  };
  const used = new Set();
  globalShortcut.unregisterAll();
  let changed = false;
  for (const key of ['select', 'realtime']) {
    const candidates = [cfg[key], ...fallbacks[key]]
      .filter(Boolean)
      .filter((accel, index, list) => list.indexOf(accel) === index)
      .filter((accel) => !used.has(accel));
    let registered = null;
    for (const accelerator of candidates) {
      try {
        if (globalShortcut.register(accelerator, actions[key])) {
          registered = accelerator;
          break;
        }
      } catch {}
    }
    if (registered) {
      used.add(registered);
      results[key] = true;
      if (registered !== cfg[key]) {
        cfg[key] = registered;
        changed = true;
        messages.push(
          `${original[key] || '原快捷键'} 被占用，已改用 ${registered}`,
        );
      }
    } else {
      messages.push(`${key === 'select' ? '框选' : '实时字幕'}没有可用的快捷键，请在设置中修改`);
    }
  }
  if (changed) settings.update({ hotkeys: cfg });
  hotkeyStatus = { ...results, messages };
  broadcastState();
}

function applySettingsPatch(patch) {
  const clean = JSON.parse(JSON.stringify(patch || {}));
  if (clean.provider) {
    if (clean.provider.clearApiKey) {
      clean.provider.apiKey = '';
      delete clean.provider.clearApiKey;
    } else if (clean.provider.apiKey === '') {
      delete clean.provider.apiKey;
    }
  }
  const before = settings.get();
  const next = settings.update(clean);
  if (before.launchAtLogin !== next.launchAtLogin) applyLoginItem(next.launchAtLogin);
  if (
    before.hotkeys.select !== next.hotkeys.select ||
    before.hotkeys.realtime !== next.hotkeys.realtime
  ) {
    registerHotkeys();
  }
  if (before.historyLimit !== next.historyLimit) history.setLimit(next.historyLimit);
  if (JSON.stringify(before.realtime) !== JSON.stringify(next.realtime)) {
    realtime?.refreshSettings();
    if (audio?.isActive()) audio.refreshSettings();
  }
  if (audio?.isActive() && JSON.stringify(before.audio) !== JSON.stringify(next.audio)) {
    if (
      before.audio.source !== next.audio.source ||
      before.audio.chunkMs !== next.audio.chunkMs ||
      before.audio.overlapMs !== next.audio.overlapMs
    ) {
      notify('音频设置已更改', '请停止后重新开启音频字幕，以应用新的音频来源/分块设置');
    }
  }
  if (
    before.targetLang !== next.targetLang ||
    before.smartSwap !== next.smartSwap
  ) {
    realtime?.invalidate();
  }
  session?.refreshCurrent();
  broadcastState();
  return next;
}

function isSubtitleWindow(win) {
  if (!win || win.isDestroyed()) return false;
  return Boolean((realtime && realtime.win === win) || (audio && audio.win === win));
}

function registerIpc() {
  ipcMain.on('window:focus', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed() || win !== homeWin) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  ipcMain.handle('action:restart-ocr', async () => {
    try {
      ocrState = { status: 'starting', languages: [], error: '' };
      broadcastState();
      const res = await ocr.restart();
      ocrState = { status: 'ready', languages: res.languages || [], error: '' };
      broadcastState();
      return { ok: true };
    } catch (err) {
      ocrState = { status: 'error', languages: [], error: err.message };
      broadcastState();
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on('audio:chunk', (event, data) => {
    if (!audio || !audio.capture || audio.capture.isDestroyed()) return;
    if (event.sender.id !== audio.capture.webContents.id) return;
    audio.pushChunk(data);
  });

  ipcMain.on('audio:status', (event, payload) => {
    if (!audio || !audio.capture || audio.capture.isDestroyed()) return;
    if (event.sender.id !== audio.capture.webContents.id) return;
    audio.onCaptureStatus(payload);
  });

  ipcMain.on('realtime:resize', (event, height) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) resizeRealtimeWindow(win, height);
  });

  ipcMain.on('realtime:hitzone', (event, zone) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) updateRealtimeHitzone(win, zone);
  });

  ipcMain.on('realtime:drag-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) startRealtimeDrag(win);
  });

  ipcMain.on('realtime:drag-move', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) moveRealtimeDrag(win);
  });

  ipcMain.on('realtime:drag-end', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) endRealtimeDrag(win);
  });

  ipcMain.on('realtime:resize-start', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) startRealtimeResize(win);
  });

  ipcMain.on('realtime:resize-move', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) moveRealtimeResize(win);
  });

  ipcMain.on('realtime:resize-end', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (isSubtitleWindow(win)) endRealtimeResize(win);
  });

  ipcMain.handle('realtime:reset-size', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isSubtitleWindow(win)) return { ok: false };
    const controller = realtime?.win === win ? realtime : (audio?.win === win ? audio : null);
    settings.update({ realtime: { boxWidth: 0, boxHeight: 0 } });
    resetRealtimeSize(win);
    controller?.refreshSettings();
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle('realtime:settings', (event, patch) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !isSubtitleWindow(win)) return { ok: false };
    const clean = {};
    for (const key of ['fontSize', 'opacity', 'maxLines', 'engine', 'sourceLang', 'targetLang', 'boxWidth', 'boxHeight']) {
      if (patch && patch[key] !== undefined) clean[key] = patch[key];
    }
    if (clean.boxWidth !== undefined || clean.boxHeight !== undefined) {
      const [width, height] = win.getSize();
      clean.boxWidth = width;
      clean.boxHeight = height;
    }
    if (!Object.keys(clean).length) return { ok: true, realtime: settings.get().realtime };
    const before = settings.get().realtime;
    const next = settings.update({ realtime: clean });
    if (
      before.sourceLang !== next.realtime.sourceLang ||
      before.targetLang !== next.realtime.targetLang
    ) {
      realtime.invalidate();
    }
    broadcastState();
    return { ok: true, realtime: next.realtime };
  });

  ipcMain.handle('app:state', () => state());

  ipcMain.handle('settings:update', (event, patch) => {
    const next = applySettingsPatch(patch);
    return { ok: true, settings: settings.getPublic(), hotkeys: hotkeyStatus, state: state() };
  });

  ipcMain.handle('provider:test', async (event, draft) => {
    try {
      const stored = settings.get().provider;
      const provider = {
        ...stored,
        ...(draft || {}),
        apiKey: draft?.apiKey || stored.apiKey,
      };
      const result = await testProvider(provider);
      return { ok: true, ...result };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('action:select', () => {
    if (selecting) return { ok: false, reason: 'busy' };
    if (audio.isActive()) audio.stop({ silent: true });
    session.startSelection();
    return { ok: true };
  });

  ipcMain.handle('action:realtime', () => {
    if (realtime.isActive()) return { ok: true, active: true };
    if (selecting) return { ok: false, reason: 'busy' };
    if (audio.isActive()) audio.stop({ silent: true });
    realtime.start();
    return { ok: true };
  });

  ipcMain.handle('action:audio', async () => {
    if (audio.isActive()) {
      audio.stop();
      return { ok: true, active: false };
    }
    if (realtime.isActive()) {
      return { ok: false, reason: 'busy', error: '请先停止实时字幕' };
    }
    if (selecting) return { ok: false, reason: 'busy' };
    return audio.start();
  });

  ipcMain.handle('action:stop-realtime', () => {
    if (audio.isActive()) audio.stop();
    realtime.stop();
    return { ok: true };
  });

  ipcMain.handle('action:retranslate', (event, options) => {
    session.retranslate(options || {});
    return { ok: true };
  });

  ipcMain.handle('action:explain', (event, options) => {
    session.explain(options || {});
    return { ok: true };
  });

  ipcMain.handle('action:set-domain', (event, payload) => {
    session.setDomain(payload?.domain);
    return { ok: true };
  });

  ipcMain.handle('action:related', (event, options) => {
    session.ensureRelated(options || {}).catch(() => {});
    return { ok: true };
  });

  ipcMain.handle('search:open', async (event, url) => {
    const value = String(url || '');
    if (!isAllowedSearchUrl(value)) {
      return { ok: false, error: '链接不在允许的搜索站点内' };
    }
    try {
      await shell.openExternal(value);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('action:open-history', (event, id) => {
    session.openHistory(String(id || ''));
    return { ok: true };
  });

  ipcMain.handle('action:close-result', () => {
    session.closeResult();
    return { ok: true };
  });

  ipcMain.handle('action:copy', (event, text) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });

  ipcMain.handle('action:open-settings', () => {
    if (resultWindow.isOpen()) resultWindow.hide();
    navigate('settings');
    return { ok: true };
  });

  ipcMain.handle('action:open-data', async () => {
    await shell.openPath(app.getPath('userData'));
    return { ok: true };
  });

  ipcMain.handle('action:remove-history', (event, id) => {
    history.remove(String(id || ''));
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle('action:clear-history', (event) => {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['取消', '清空'],
      defaultId: 0,
      cancelId: 0,
      title: '清空历史记录',
      message: '确定要清空全部历史记录和截图吗？',
      noLink: true,
    });
    if (choice === 1) {
      history.clear();
      broadcastState();
      return { ok: true, cleared: true };
    }
    return { ok: false, cleared: false };
  });

  ipcMain.handle('action:open-external', async (event, url) => {
    const value = String(url || '');
    if (!/^https?:\/\//i.test(value)) return { ok: false };
    await shell.openExternal(value);
    return { ok: true };
  });

  ipcMain.handle('result:get', () => resultWindow.record);

  ipcMain.handle('result:pin', () => ({
    ok: true,
    pinned: resultWindow.togglePin(),
  }));

  ipcMain.handle('window:minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false };
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return { ok: true, maximized: win.isMaximized() };
  });

  ipcMain.handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { ok: false };
    if (win === homeWin) win.hide();
    else win.close();
    return { ok: true };
  });

  ipcMain.handle('window:hide', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.hide();
    return { ok: true };
  });

  ipcMain.handle('app:quit', () => {
    quitting = true;
    app.quit();
    return { ok: true };
  });
}

async function bootstrap() {
  const userData = app.getPath('userData');
  const tempDir = path.join(app.getPath('temp'), 'ScreenLens');
  fs.mkdirSync(tempDir, { recursive: true });

  settings = new SettingsStore(userData);
  history = new HistoryStore({ dir: path.join(userData, 'history'), limit: settings.get().historyLimit });
  ocr = new OcrService({ dir: path.join(tempDir, 'ocr') });
  resultWindow = new ResultWindow();
  session = new SessionManager({
    settings,
    ocr,
    history,
    resultWindow,
    tempDir,
    onHistoryChanged: broadcastState,
    onStateChange: (patch) => {
      if ('selecting' in patch) selecting = patch.selecting;
      if ('realtimeActive' in patch) realtimeState = { active: patch.realtimeActive };
      broadcastState();
    },
    notify,
  });
  realtime = new RealtimeController({
    settings,
    ocr,
    tempDir,
    onStateChange: (patch) => {
      if ('selecting' in patch) selecting = patch.selecting;
      if ('realtimeActive' in patch) realtimeState = { active: patch.realtimeActive };
      broadcastState();
    },
    notify,
    hideResult: () => {
      const wasOpen = resultWindow.isOpen();
      resultWindow.hide();
      return wasOpen;
    },
    restoreResult: () => session.restoreResult(),
  });
  audio = new AudioController({
    settings,
    tempDir,
    rootDir: ROOT,
    onStateChange: (patch) => {
      if ('audioActive' in patch) audioState = { active: patch.audioActive };
      broadcastState();
    },
    notify,
  });

  protocol.handle('shot', async (request) => {
    try {
      const url = new URL(request.url);
      const host = url.hostname;
      const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      if (!['history', 'thumb'].includes(host)) return new Response('Not found', { status: 404 });
      const file = history.resolveImage(host, name);
      if (!file) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).toString());
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  createHomeWindow();
  createTray();
  registerHotkeys();
  applyLoginItem(settings.get().launchAtLogin);

  ocr.on('ready', ({ languages }) => {
    ocrState = { status: 'ready', languages, error: '' };
    broadcastState();
  });
  ocr.on('error', (err) => {
    ocrState = { status: 'error', languages: [], error: err.message };
    broadcastState();
    notify('OCR 引擎不可用', err.message);
  });

  ocr.start().then(({ languages }) => {
    ocrState = { status: 'ready', languages, error: '' };
    broadcastState();
  }).catch((err) => {
    ocrState = { status: 'error', languages: [], error: err.message };
    broadcastState();
    notify('OCR 引擎初始化失败', err.message);
  });

  app.on('second-instance', showHome);
}

if (gotLock) {
  app.whenReady().then(bootstrap).catch((err) => {
    dialog.showErrorBox('ScreenLens 启动失败', err.stack || err.message);
    app.quit();
  });
}

app.on('window-all-closed', () => {
  if (quitting) app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  try { globalShortcut.unregisterAll(); } catch {}
  try { realtime?.stop({ silent: true }); } catch {}
  try { audio?.stop({ silent: true }); } catch {}
  try { ocr?.stop(); } catch {}
});
