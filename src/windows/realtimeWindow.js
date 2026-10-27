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
    win.setAlwaysOnTop(false);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.moveTop();
  } catch {}
}

function resizeRealtimeWindow(win, height) {
  const placement = win.__screenlensPlacement;
  if (!placement) return;
  const display = screen.getDisplayMatching({
    x: placement.anchor.x,
    y: placement.anchor.y,
    width: Math.max(1, placement.anchor.width || 1),
    height: Math.max(1, placement.anchor.height || 1),
  });
  const work = display.workArea;
  const target = Math.round(clamp(Number(height) || 100, 92, 340));
  const bounds = win.getBounds();
  if (Math.abs(bounds.height - target) < 3) return;
  let y = bounds.y;
  if (!placement.below) y = bounds.y + bounds.height - target;
  y = Math.round(clamp(y, work.y + 8, work.y + work.height - target - 8));
  win.setBounds({ x: bounds.x, y, width: bounds.width, height: target });
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
    movable: false,
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
  win.__screenlensPlacement = { anchor: rect, below: bounds.below };
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'realtime', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('realtime:init', {
      fontSize: settings.realtime.fontSize,
      opacity: settings.realtime.opacity,
      maxLines: settings.realtime.maxLines,
      hotkey: settings.hotkeys.realtime,
      below: bounds.below,
    });
    win.showInactive();
    raiseRealtimeWindow(win);
    setTimeout(() => raiseRealtimeWindow(win), 300);
  });
  return win;
}

module.exports = { createRealtimeWindow, computeBounds, resizeRealtimeWindow };
