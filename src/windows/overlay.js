const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { captureDisplays } = require('../core/capture');
const { startTiming, markTiming, finishTiming } = require('../core/timing');

const OVERLAY_FILE = path.join(__dirname, '..', 'renderer', 'overlay', 'index.html');
const overlayPool = new Map();
let poolEventsReady = false;
let activeSession = null;
let handlersReady = false;

function ensureHandlers() {
  if (handlersReady) return;
  handlersReady = true;
  ipcMain.on('overlay:submit', (event, payload) => {
    const session = activeSession;
    if (!session) return;
    const displayShot = session.shots.find(
      (item) => String(item.display.id) === String(payload?.displayId),
    );
    if (!displayShot) return;
    const rect = {
      x: Math.round(displayShot.display.bounds.x + Number(payload.x || 0)),
      y: Math.round(displayShot.display.bounds.y + Number(payload.y || 0)),
      width: Math.round(Number(payload.width || 0)),
      height: Math.round(Number(payload.height || 0)),
    };
    if (rect.width < 6 || rect.height < 6) return;
    const windowId = String(payload.windowId || '').replace(/\D/g, '').slice(0, 20);
    const windowInfo = windowId
      ? { id: windowId, title: String(payload.windowTitle || '').slice(0, 120) }
      : null;
    session.finish({ rect, displayShot, window: windowInfo });
  });
  ipcMain.on('overlay:cancel', (event) => {
    const session = activeSession;
    if (!session) return;
    const index = session.windows.findIndex((win) => win.webContents.id === event.sender.id);
    if (index >= 0) session.finish(null);
  });
  ipcMain.on('overlay:ready', (event, payload) => {
    const session = activeSession;
    if (!session) return;
    const win = session.windows.find((item) => item.webContents.id === event.sender.id);
    if (!win || win.isDestroyed()) return;
    const timingId = payload?.timingId || session.timingId;
    if (win.__showTimer) {
      clearTimeout(win.__showTimer);
      win.__showTimer = null;
    }
    markTiming(timingId, 'overlay-ready', {
      displayId: payload?.displayId,
      focus: session.focusWin === win,
      image: payload?.image,
    });
    showOverlayWindow(win, session, timingId, {});
  });
  ipcMain.on('overlay:frame', (event, payload) => {
    const session = activeSession;
    if (!session) return;
    const win = session.windows.find((item) => item.webContents.id === event.sender.id);
    if (!win || win.isDestroyed()) return;
    const timingId = payload?.timingId || session.timingId;
    const focus = session.focusWin === win;
    markTiming(timingId, 'overlay-first-frame', { displayId: payload?.displayId, focus });
    if (focus && session.finishOnFrame !== false) finishTiming(timingId, { outcome: 'ready' });
  });
}

function intersects(a, b) {
  return a.x < b.x + b.width
    && a.x + a.width > b.x
    && a.y < b.y + b.height
    && a.y + a.height > b.y;
}

function physicalRectToDip(rect) {
  const value = rect || {};
  const x = Number(value.x) || 0;
  const y = Number(value.y) || 0;
  const width = Math.max(1, Number(value.w) || 0);
  const height = Math.max(1, Number(value.h) || 0);
  try {
    const topLeft = screen.screenToDipPoint({ x, y });
    const bottomRight = screen.screenToDipPoint({ x: x + width, y: y + height });
    return {
      x: Math.round(topLeft.x),
      y: Math.round(topLeft.y),
      width: Math.round(bottomRight.x - topLeft.x),
      height: Math.round(bottomRight.y - topLeft.y),
    };
  } catch {
    const display = screen.getDisplayNearestPoint({ x: x + width / 2, y: y + height / 2 });
    const scale = display.scaleFactor || 1;
    return {
      x: Math.round(x / scale),
      y: Math.round(y / scale),
      width: Math.round(width / scale),
      height: Math.round(height / scale),
    };
  }
}

function normalizeWindows(rawWindows) {
  return (Array.isArray(rawWindows) ? rawWindows : [])
    .map((item) => ({
      id: String(item.id || ''),
      title: String(item.title || '').slice(0, 120),
      rect: physicalRectToDip(item.rect),
      client: physicalRectToDip(item.client || item.rect),
    }))
    .filter((item) => item.id && item.rect.width >= 80 && item.rect.height >= 60);
}

function windowsForDisplay(windows, display) {
  return windows
    .filter((item) => intersects(item.rect, display.bounds))
    .map((item) => ({
      id: item.id,
      title: item.title,
      rect: {
        x: item.rect.x - display.bounds.x,
        y: item.rect.y - display.bounds.y,
        width: item.rect.width,
        height: item.rect.height,
      },
      client: {
        x: item.client.x - display.bounds.x,
        y: item.client.y - display.bounds.y,
        width: item.client.width,
        height: item.client.height,
      },
    }))
    .filter((item) => item.client.width >= 40 && item.client.height >= 30);
}

function makePreview(image, display) {
  if (!image || image.isEmpty()) return { buffer: null, ms: 0 };
  const started = Date.now();
  try {
    const size = image.getSize();
    const targetWidth = Math.max(1, Math.round(display.bounds.width * 1.25));
    const preview = size.width > targetWidth
      ? image.resize({ width: targetWidth, quality: 'good' })
      : image;
    return { buffer: preview.toJPEG(80), ms: Date.now() - started };
  } catch {
    return { buffer: null, ms: Date.now() - started };
  }
}

function boundsEqual(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function createPoolEntry(display) {
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    transparent: false,
    backgroundColor: '#05070b',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const entry = {
    win,
    display,
    displayId: display.id,
    reused: false,
    loaded: false,
    ready: null,
  };
  entry.ready = new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      entry.loaded = value;
      resolve(value);
    };
    win.webContents.once('did-finish-load', () => done(true));
    win.webContents.once('did-fail-load', () => done(false));
    setTimeout(() => {
      if (!settled) done(!win.isDestroyed());
    }, 5000);
  });
  win.loadFile(OVERLAY_FILE);
  win.on('closed', () => {
    overlayPool.delete(display.id);
    const session = activeSession;
    if (session && session.windows.includes(win) && !session.settled) {
      session.windows = session.windows.filter((item) => item !== win);
      if (session.windows.length === 0) session.finish(null);
    }
  });
  overlayPool.set(display.id, entry);
  return entry;
}

function ensureOverlayEntry(display) {
  const existing = overlayPool.get(display.id);
  if (existing && !existing.win.isDestroyed()) {
    existing.display = display;
    existing.reused = true;
    if (!boundsEqual(existing.win.getBounds(), display.bounds)) {
      try { existing.win.setBounds(display.bounds); } catch {}
    }
    return existing;
  }
  const entry = createPoolEntry(display);
  entry.reused = false;
  return entry;
}

function warmOverlays() {
  if (!poolEventsReady) {
    poolEventsReady = true;
    screen.on('display-added', (event, display) => {
      ensureOverlayEntry(display);
    });
    screen.on('display-removed', (event, display) => {
      const entry = overlayPool.get(display.id);
      if (entry && !entry.win.isDestroyed()) {
        try { entry.win.destroy(); } catch {}
      }
      overlayPool.delete(display.id);
    });
    screen.on('display-metrics-changed', (event, display) => {
      const entry = overlayPool.get(display.id);
      if (!entry || entry.win.isDestroyed()) return;
      entry.display = display;
      try { entry.win.setBounds(display.bounds); } catch {}
    });
  }
  for (const display of screen.getAllDisplays()) ensureOverlayEntry(display);
}

function disposeOverlays() {
  for (const entry of overlayPool.values()) {
    if (!entry.win.isDestroyed()) {
      try { entry.win.destroy(); } catch {}
    }
  }
  overlayPool.clear();
}

function showOverlayWindow(win, session, timingId, extra) {
  if (win.isDestroyed()) return;
  if (win.__showTimer) {
    clearTimeout(win.__showTimer);
    win.__showTimer = null;
  }
  const focus = session.focusWin === win;
  if (focus) {
    win.show();
    win.focus();
  } else {
    win.showInactive();
  }
  markTiming(timingId, 'overlay-visible', {
    displayId: win.__display ? win.__display.id : undefined,
    focus,
    ...(extra || {}),
  });
  try { win.webContents.send('overlay:shown', { timingId }); } catch {}
}

async function prepareOverlay(entry, displayShot, isFocus, session) {
  if (session.settled) return;
  const loaded = await entry.ready;
  if (!loaded || session.settled || entry.win.isDestroyed()) return;
  const win = entry.win;
  if (win.isVisible()) win.hide();
  if (win.__showTimer) {
    clearTimeout(win.__showTimer);
    win.__showTimer = null;
  }
  win.__display = displayShot.display;
  if (!session.windows.includes(win)) session.windows.push(win);
  if (isFocus) session.focusWin = win;

  const timingId = session.timingId;
  const preview = makePreview(displayShot.image, displayShot.display);
  markTiming(timingId, 'overlay-created', {
    displayId: displayShot.display.id,
    focus: isFocus,
    reused: entry.reused,
    width: displayShot.display.bounds.width,
    height: displayShot.display.bounds.height,
  });
  try {
    win.webContents.send('overlay:init', {
      image: preview.buffer,
      imageType: 'image/jpeg',
      displayId: displayShot.display.id,
      displayWidth: displayShot.display.bounds.width,
      displayHeight: displayShot.display.bounds.height,
      primary: displayShot.display.id === screen.getPrimaryDisplay().id,
      isFocus,
      sessionId: session.id,
      timingId,
      windows: windowsForDisplay(session.windowsList || [], displayShot.display),
      windowListPending: Boolean(session.windowsPending),
    });
  } catch {
    return;
  }
  markTiming(timingId, 'overlay-init-sent', {
    displayId: displayShot.display.id,
    focus: isFocus,
    reused: entry.reused,
    encodeMs: preview.ms,
    bytes: preview.buffer ? preview.buffer.length : 0,
  });
  win.__showTimer = setTimeout(() => {
    win.__showTimer = null;
    if (session.settled || win.isDestroyed() || !session.windows.includes(win)) return;
    if (win.isVisible()) return;
    markTiming(timingId, 'overlay-fallback-show', {
      displayId: displayShot.display.id,
      focus: isFocus,
    });
    showOverlayWindow(win, session, timingId, { fallback: true });
  }, 1500);
}

async function selectRegion(options = {}) {
  ensureHandlers();
  if (activeSession) return null;
  const timingId = options.timingId || startTiming('select', { source: 'overlay' });
  markTiming(timingId, 'capture-start');
  const rawWindows = Array.isArray(options.windows) ? options.windows : [];
  const windows = normalizeWindows(rawWindows);
  const windowsProvider = typeof options.windowsProvider === 'function' ? options.windowsProvider : null;
  const capture = typeof options.capture === 'function' ? options.capture : captureDisplays;
  let shots = null;
  let captureError = null;
  try {
    shots = await capture({ timingId });
  } catch (err) {
    captureError = err;
    markTiming(timingId, 'capture-error', {
      mode: options.capture ? 'fast' : 'native',
      message: String(err.message || '').slice(0, 160),
    });
  }
  if (!Array.isArray(shots) || !shots.length) {
    if (options.capture && captureError) {
      try {
        shots = await captureDisplays();
        markTiming(timingId, 'capture-fallback', { displays: shots.length });
      } catch (fallbackErr) {
        markTiming(timingId, 'capture-error', {
          mode: 'fallback',
          message: String(fallbackErr.message || '').slice(0, 160),
        });
        throw fallbackErr;
      }
    } else if (captureError) {
      throw captureError;
    }
  }
  markTiming(timingId, 'capture-end', { displays: shots.length });
  if (!shots.length) throw new Error('没有检测到显示器');
  const cursor = screen.getCursorScreenPoint();
  const focusDisplay = screen.getDisplayNearestPoint(cursor).id;

  return new Promise((resolve, reject) => {
    if (activeSession) {
      resolve(null);
      return;
    }
    const session = {
      id: Date.now(),
      timingId,
      finishOnFrame: options.finishOnFrame !== false,
      windows: [],
      windowsList: windows,
      windowsPending: Boolean(windowsProvider),
      shots,
      settled: false,
      focusWin: null,
      finish(result) {
        if (this.settled) return;
        this.settled = true;
        if (activeSession === this) activeSession = null;
        for (const win of this.windows.slice()) {
          if (!win.isDestroyed()) {
            if (win.__showTimer) {
              clearTimeout(win.__showTimer);
              win.__showTimer = null;
            }
            try { win.webContents.send('overlay:reset'); } catch {}
            try { win.hide(); } catch {}
          }
        }
        this.windows.length = 0;
        this.focusWin = null;
        if (result) resolve(result);
        else resolve(null);
      },
    };
    activeSession = session;

    if (windowsProvider) {
      markTiming(timingId, 'windows-list-start');
      Promise.resolve()
        .then(() => windowsProvider())
        .then((raw) => {
          if (session.settled) return;
          const list = normalizeWindows(raw);
          session.windowsList = list;
          session.windowsPending = false;
          markTiming(timingId, 'windows-list-end', { windows: list.length });
          for (const win of session.windows) {
            if (win.isDestroyed() || !win.__display) continue;
            try {
              win.webContents.send('overlay:windows', {
                windows: windowsForDisplay(list, win.__display),
              });
            } catch {}
          }
        })
        .catch((err) => {
          session.windowsPending = false;
          markTiming(timingId, 'windows-list-error', {
            message: String(err.message || '').slice(0, 160),
          });
        });
    }

    const focusShot = shots.find((item) => item.display.id === focusDisplay) || shots[0];
    const others = shots.filter((item) => item !== focusShot);
    (async () => {
      const focusEntry = ensureOverlayEntry(focusShot.display);
      await prepareOverlay(focusEntry, focusShot, true, session);
      for (const shot of others) {
        if (session.settled) break;
        const entry = ensureOverlayEntry(shot.display);
        prepareOverlay(entry, shot, false, session).catch(() => {});
      }
      if (!session.settled && !session.windows.length) {
        markTiming(timingId, 'overlay-empty');
        session.finish(null);
      }
    })().catch((err) => {
      markTiming(timingId, 'overlay-prepare-error', {
        message: String(err.message || '').slice(0, 160),
      });
      if (!session.settled && !session.windows.length) session.finish(null);
    });
  });
}

function cancelSelection() {
  if (activeSession) activeSession.finish(null);
}

module.exports = { selectRegion, cancelSelection, warmOverlays, disposeOverlays };
