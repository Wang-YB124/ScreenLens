const { BrowserWindow, screen } = require('electron');
const path = require('path');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeBounds(rect, settings) {
  const anchor = rect || { x: 0, y: 0, width: 1, height: 1 };
  const display = screen.getDisplayMatching({
    x: anchor.x,
    y: anchor.y,
    width: Math.max(1, anchor.width || 1),
    height: Math.max(1, anchor.height || 1),
  });
  const work = display.workArea;
  const rt = settings.realtime;
  const height = Math.round(92 + rt.fontSize * 1.45 * rt.maxLines);
  const width = Math.round(
    Math.min(Math.max(anchor.width + 200, 440), Math.min(980, work.width - 24)),
  );
  const x = Math.round(
    clamp(anchor.x + anchor.width / 2 - width / 2, work.x + 12, work.x + work.width - width - 12),
  );
  let y = anchor.y + anchor.height + 12;
  if (y + height > work.y + work.height - 12) {
    y = anchor.y - height - 12;
  }
  y = Math.round(clamp(y, work.y + 12, work.y + work.height - height - 12));
  return { x, y, width, height, below: y > anchor.y };
}

function raiseRealtimeWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  } catch {}
}

function buildRealtimeInit(settings, win) {
  const placement = win && win.__screenlensPlacement;
  return {
    fontSize: settings.realtime.fontSize,
    opacity: settings.realtime.opacity,
    maxLines: settings.realtime.maxLines,
    sourceLang: settings.realtime.sourceLang,
    targetLang: settings.realtime.targetLang,
    hotkey: settings.hotkeys.realtime,
    below: placement ? placement.below : true,
  };
}

function sendRealtimeInit(win, settings) {
  if (!win || win.isDestroyed() || !settings) return;
  win.webContents.send('realtime:init', buildRealtimeInit(settings, win));
}

function setRealtimeInteractive(win, interactive) {
  if (!win || win.isDestroyed()) return;
  win.__screenlensInteractive = Boolean(interactive);
  win.setIgnoreMouseEvents(!interactive);
}

function updateRealtimeHitzone(win, zone) {
  if (!win || win.isDestroyed()) return;
  const metaBottom = Number(zone && zone.metaBottom);
  win.__screenlensHit = {
    metaBottom: Math.max(24, Math.min(180, Number.isFinite(metaBottom) ? metaBottom : 44)),
    panelOpen: Boolean(zone && zone.panelOpen),
  };
}

function startRealtimeWatcher(win) {
  if (!win || win.isDestroyed()) return;
  if (win.__screenlensWatcher) clearInterval(win.__screenlensWatcher);
  win.__screenlensHit = { metaBottom: 44, panelOpen: false };
  win.__screenlensInteractive = false;
  win.__screenlensDragging = false;
  win.__screenlensWatcher = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(win.__screenlensWatcher);
      win.__screenlensWatcher = null;
      return;
    }
    if (win.__screenlensDragging) {
      if (!win.__screenlensInteractive) setRealtimeInteractive(win, true);
      return;
    }
    const now = Date.now();
    if (!win.__screenlensRaisedAt || now - win.__screenlensRaisedAt > 700) {
      win.__screenlensRaisedAt = now;
      try { win.moveTop(); } catch {}
    }
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const zone = win.__screenlensHit;
    const inside = point.x >= bounds.x && point.x < bounds.x + bounds.width
      && point.y >= bounds.y && point.y < bounds.y + bounds.height;
    const hit = inside && (zone.panelOpen || point.y - bounds.y <= zone.metaBottom);
    if (hit !== win.__screenlensInteractive) setRealtimeInteractive(win, hit);
  }, 50);
  win.on('closed', () => {
    if (win.__screenlensWatcher) clearInterval(win.__screenlensWatcher);
    win.__screenlensWatcher = null;
  });
}

let dragState = null;

function startRealtimeDrag(win) {
  if (!win || win.isDestroyed()) return;
  win.__screenlensDragging = true;
  setRealtimeInteractive(win, true);
  dragState = {
    win,
    cursor: screen.getCursorScreenPoint(),
    pos: win.getPosition(),
    size: win.getSize(),
  };
}

function moveRealtimeDrag(win) {
  if (!dragState || dragState.win !== win || !win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const work = screen.getDisplayNearestPoint(cursor).workArea;
  const [width, height] = dragState.size;
  const nextX = dragState.pos[0] + (cursor.x - dragState.cursor.x);
  const nextY = dragState.pos[1] + (cursor.y - dragState.cursor.y);
  const x = Math.round(clamp(nextX, work.x, work.x + work.width - width));
  const y = Math.round(clamp(nextY, work.y, work.y + work.height - height));
  const bounds = win.getBounds();
  if (x !== bounds.x || y !== bounds.y || bounds.width !== width || bounds.height !== height) {
    win.setBounds({ x, y, width, height });
  }
}

function endRealtimeDrag(win) {
  if (!dragState || dragState.win !== win) return;
  dragState = null;
  if (!win || win.isDestroyed()) return;
  win.__screenlensDragging = false;
  const placement = win.__screenlensPlacement;
  const bounds = win.getBounds();
  if (placement && placement.width && Math.abs(bounds.width - placement.width) > 1) {
    win.setBounds({ ...bounds, width: placement.width });
  }
  win.__screenlensPlacement = { ...placement, manual: true };
  raiseRealtimeWindow(win);
}

function resizeRealtimeWindow(win, height) {
  const placement = win.__screenlensPlacement;
  if (!placement) return;
  if (win.__screenlensDragging) return;
  const target = Math.round(clamp(Number(height) || 100, 92, 340));
  const bounds = win.getBounds();
  const width = placement.width || bounds.width;
  if (Math.abs(bounds.height - target) < 3) return;
  if (placement.manual) {
    const work = screen.getDisplayMatching(bounds).workArea;
    const y = Math.round(clamp(bounds.y, work.y + 8, work.y + work.height - target - 8));
    win.setBounds({ x: bounds.x, y, width, height: target });
    raiseRealtimeWindow(win);
    return;
  }
  const display = screen.getDisplayMatching({
    x: placement.anchor.x,
    y: placement.anchor.y,
    width: Math.max(1, placement.anchor.width || 1),
    height: Math.max(1, placement.anchor.height || 1),
  });
  const work = display.workArea;
  let y = bounds.y;
  if (!placement.below) y = bounds.y + bounds.height - target;
  y = Math.round(clamp(y, work.y + 8, work.y + work.height - target - 8));
  win.setBounds({ x: bounds.x, y, width, height: target });
  raiseRealtimeWindow(win);
}

function createRealtimeWindow({ rect, settings }) {
  const bounds = computeBounds(rect, settings);
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.__screenlensPlacement = { anchor: rect, below: bounds.below, manual: false, width: bounds.width };
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true);
  startRealtimeWatcher(win);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'realtime', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    sendRealtimeInit(win, settings);
    win.showInactive();
    raiseRealtimeWindow(win);
    setTimeout(() => raiseRealtimeWindow(win), 300);
  });
  return win;
}

module.exports = {
  createRealtimeWindow,
  computeBounds,
  resizeRealtimeWindow,
  sendRealtimeInit,
  setRealtimeInteractive,
  updateRealtimeHitzone,
  startRealtimeDrag,
  moveRealtimeDrag,
  endRealtimeDrag,
};
