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
  let below = true;
  if (y + height > work.y + work.height - 12) {
    y = anchor.y - height - 12;
    below = false;
    if (y < work.y + 12) {
      y = anchor.y + anchor.height - height - 20;
    }
  }
  y = Math.round(clamp(y, work.y + 12, work.y + work.height - height - 12));
  return { x, y, width, height, below };
}

function raiseRealtimeWindow(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
    win.__screenlensIgnoreApplied = false;
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
    windowTitle: (win && win.__screenlensWindowTitle) || '',
    scope: (win && win.__screenlensScope) || '',
    boxWidth: settings.realtime.boxWidth,
    boxHeight: settings.realtime.boxHeight,
  };
}

function sendRealtimeInit(win, settings) {
  if (!win || win.isDestroyed() || !settings) return;
  win.webContents.send('realtime:init', buildRealtimeInit(settings, win));
}

function setRealtimeInteractive(win, interactive) {
  if (!win || win.isDestroyed()) return;
  const next = Boolean(interactive);
  if (win.__screenlensInteractive === next && win.__screenlensIgnoreApplied) return;
  try {
    win.setIgnoreMouseEvents(!next);
    win.__screenlensInteractive = next;
    win.__screenlensIgnoreApplied = true;
  } catch {
    win.__screenlensIgnoreApplied = false;
  }
}

function updateRealtimeHitzone(win, zone) {
  if (!win || win.isDestroyed()) return;
  const metaBottom = Number(zone && zone.metaBottom);
  const grip = zone && zone.grip;
  win.__screenlensHit = {
    metaBottom: Math.max(24, Math.min(180, Number.isFinite(metaBottom) ? metaBottom : 44)),
    panelOpen: Boolean(zone && zone.panelOpen),
    grip: grip
      ? {
        x: Math.max(0, Number(grip.x) || 0),
        y: Math.max(0, Number(grip.y) || 0),
        width: Math.max(1, Number(grip.width) || 0),
        height: Math.max(1, Number(grip.height) || 0),
      }
      : null,
  };
}

function startRealtimeWatcher(win) {
  if (!win || win.isDestroyed()) return;
  if (win.__screenlensWatcher) clearInterval(win.__screenlensWatcher);
  win.__screenlensHit = { metaBottom: 44, panelOpen: false, grip: null };
  win.__screenlensInteractive = false;
  win.__screenlensDragging = false;
  win.__screenlensResizing = false;
  win.__screenlensWatcher = setInterval(() => {
    if (!win || win.isDestroyed()) {
      clearInterval(win.__screenlensWatcher);
      win.__screenlensWatcher = null;
      return;
    }
    if (win.__screenlensDragging || win.__screenlensResizing) {
      if (!win.__screenlensInteractive || !win.__screenlensIgnoreApplied) {
        setRealtimeInteractive(win, true);
      }
      return;
    }
    const now = Date.now();
    if (!win.__screenlensRaisedAt || now - win.__screenlensRaisedAt > 700) {
      win.__screenlensRaisedAt = now;
      try {
        win.moveTop();
        win.__screenlensIgnoreApplied = false;
      } catch {}
    }
    const point = screen.getCursorScreenPoint();
    const bounds = win.getBounds();
    const zone = win.__screenlensHit;
    const localX = point.x - bounds.x;
    const localY = point.y - bounds.y;
    const inside = localX >= 0 && localX < bounds.width && localY >= 0 && localY < bounds.height;
    const inGrip = Boolean(zone.grip)
      && localX >= zone.grip.x
      && localX <= zone.grip.x + zone.grip.width
      && localY >= zone.grip.y
      && localY <= zone.grip.y + zone.grip.height;
    const hit = inside && (zone.panelOpen || localY <= zone.metaBottom || inGrip);
    if (hit !== win.__screenlensInteractive || !win.__screenlensIgnoreApplied) {
      setRealtimeInteractive(win, hit);
    }
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

let resizeState = null;

function startRealtimeResize(win) {
  if (!win || win.isDestroyed()) return;
  win.__screenlensResizing = true;
  setRealtimeInteractive(win, true);
  resizeState = {
    win,
    cursor: screen.getCursorScreenPoint(),
    bounds: win.getBounds(),
    moved: false,
  };
}

function moveRealtimeResize(win) {
  if (!resizeState || resizeState.win !== win || !win || win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const start = resizeState.bounds;
  const work = screen.getDisplayNearestPoint(cursor).workArea;
  const maxWidth = Math.max(320, work.x + work.width - start.x - 8);
  const maxHeight = Math.max(96, work.y + work.height - start.y - 8);
  const width = Math.round(clamp(start.width + cursor.x - resizeState.cursor.x, 320, Math.min(1600, maxWidth)));
  const height = Math.round(clamp(start.height + cursor.y - resizeState.cursor.y, 96, Math.min(700, maxHeight)));
  const current = win.getBounds();
  if (current.width !== width || current.height !== height) {
    resizeState.moved = true;
    win.setBounds({ x: current.x, y: current.y, width, height });
  }
}

function endRealtimeResize(win) {
  if (!resizeState || resizeState.win !== win) return;
  const moved = resizeState.moved;
  resizeState = null;
  if (!win || win.isDestroyed()) return;
  win.__screenlensResizing = false;
  if (!moved) return;
  win.__screenlensManualHeight = true;
  const bounds = win.getBounds();
  const placement = win.__screenlensPlacement;
  win.__screenlensPlacement = {
    ...placement,
    manual: true,
    manualHeight: true,
    width: bounds.width,
  };
  raiseRealtimeWindow(win);
}

function resetRealtimeSize(win) {
  if (!win || win.isDestroyed()) return;
  const placement = win.__screenlensPlacement;
  if (!placement) return;
  win.__screenlensManualHeight = false;
  const bounds = win.getBounds();
  const width = placement.autoWidth || placement.width || bounds.width;
  const work = screen.getDisplayMatching(bounds).workArea;
  const x = Math.round(clamp(bounds.x, work.x + 8, work.x + work.width - width - 8));
  win.setBounds({ x, y: bounds.y, width });
  win.__screenlensPlacement = { ...placement, width, manualHeight: false };
  raiseRealtimeWindow(win);
}

function resizeRealtimeWindow(win, height) {
  const placement = win.__screenlensPlacement;
  if (!placement) return;
  if (win.__screenlensDragging || win.__screenlensResizing || win.__screenlensManualHeight) return;
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

function createRealtimeWindow({ rect, settings, windowTitle = '', scope = '' }) {
  const bounds = computeBounds(rect, settings);
  const rt = settings.realtime;
  const anchor = rect || { x: 0, y: 0, width: 1, height: 1 };
  const work = screen.getDisplayMatching({
    x: anchor.x,
    y: anchor.y,
    width: Math.max(1, anchor.width || 1),
    height: Math.max(1, anchor.height || 1),
  }).workArea;
  const autoWidth = bounds.width;
  if (rt.boxWidth > 0) {
    bounds.width = Math.round(clamp(rt.boxWidth, 320, Math.min(1600, work.width - 24)));
    bounds.x = Math.round(clamp(bounds.x, work.x + 8, work.x + work.width - bounds.width - 8));
  }
  if (rt.boxHeight > 0) {
    bounds.height = Math.round(clamp(rt.boxHeight, 96, Math.min(700, work.height - 24)));
    bounds.y = Math.round(clamp(bounds.y, work.y + 8, work.y + work.height - bounds.height - 8));
  }
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
  win.__screenlensPlacement = {
    anchor: rect,
    below: bounds.below,
    manual: false,
    width: bounds.width,
    autoWidth,
    manualHeight: rt.boxHeight > 0,
  };
  win.__screenlensManualHeight = rt.boxHeight > 0;
  win.__screenlensWindowTitle = String(windowTitle || '');
  win.__screenlensScope = String(scope || '');
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  try { win.setContentProtection(true); } catch {}
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
  startRealtimeResize,
  moveRealtimeResize,
  endRealtimeResize,
  resetRealtimeSize,
};
