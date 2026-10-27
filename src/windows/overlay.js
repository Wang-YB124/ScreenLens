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
    session.finish({ rect, displayShot });
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

function createOverlayWindow(displayShot, init, isFocus, session) {
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

async function selectRegion() {
  ensureHandlers();
  if (activeSession) return null;
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
        const win = createOverlayWindow(shot, null, isFocus, session);
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
