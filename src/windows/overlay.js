const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { captureDisplays } = require('../core/capture');

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
  ipcMain.on('overlay:ready', (event) => {
    const session = activeSession;
    if (!session) return;
    const win = session.windows.find((item) => item.webContents.id === event.sender.id);
    if (!win || win.isDestroyed()) return;
    if (session.focusWin && session.focusWin.webContents.id === event.sender.id) {
      win.show();
      win.focus();
    } else {
      win.showInactive();
    }
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

function createOverlayWindow(displayShot, windows, isFocus, session) {
  const { display, image } = displayShot;
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
  win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('overlay:init', {
      image: image ? image.toDataURL() : '',
      displayId: display.id,
      displayWidth: display.bounds.width,
      displayHeight: display.bounds.height,
      primary: display.id === screen.getPrimaryDisplay().id,
      isFocus,
      sessionId: session.id,
      windows: windowsForDisplay(windows, display),
    });
  });
  win.on('closed', () => {
    const index = session.windows.indexOf(win);
    if (index >= 0) session.windows.splice(index, 1);
    if (session.windows.length === 0 && activeSession === session && !session.settled) {
      session.finish(null);
    }
  });
  return win;
}

async function selectRegion(options = {}) {
  ensureHandlers();
  if (activeSession) return null;
  const rawWindows = Array.isArray(options.windows) ? options.windows : [];
  const windows = rawWindows
    .map((item) => ({
      id: String(item.id || ''),
      title: String(item.title || '').slice(0, 120),
      rect: physicalRectToDip(item.rect),
      client: physicalRectToDip(item.client || item.rect),
    }))
    .filter((item) => item.id && item.rect.width >= 80 && item.rect.height >= 60);
  const shots = await captureDisplays();
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
      windows: [],
      shots,
      settled: false,
      focusWin: null,
      finish(result) {
        if (this.settled) return;
        this.settled = true;
        if (activeSession === this) activeSession = null;
        for (const win of this.windows.slice()) {
          try { win.destroy(); } catch {}
        }
        this.windows.length = 0;
        if (result) resolve(result);
        else resolve(null);
      },
    };
    activeSession = session;

    try {
      for (const shot of shots) {
        const isFocus = shot.display.id === focusDisplay;
        const win = createOverlayWindow(shot, windows, isFocus, session);
        session.windows.push(win);
        if (isFocus) session.focusWin = win;
      }
      setTimeout(() => {
        if (activeSession === session && session.focusWin && !session.settled) {
          const win = session.focusWin;
          if (!win.isDestroyed() && !win.isVisible()) {
            win.show();
            win.focus();
          }
        }
      }, 1200);
    } catch (err) {
      session.finish(null);
      reject(err);
    }
  });
}

function cancelSelection() {
  if (activeSession) activeSession.finish(null);
}

module.exports = { selectRegion, cancelSelection };
