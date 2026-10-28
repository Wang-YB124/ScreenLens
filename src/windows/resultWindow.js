const { BrowserWindow, screen } = require('electron');
const path = require('path');

const CARD_WIDTH = 436;
const CARD_HEIGHT = 544;
const MARGIN = 16;

function clampToWorkArea(x, y, width, height, workArea) {
  const maxX = workArea.x + workArea.width - width - 4;
  const maxY = workArea.y + workArea.height - height - 4;
  return {
    x: Math.max(workArea.x + 4, Math.min(x, maxX)),
    y: Math.max(workArea.y + 4, Math.min(y, maxY)),
  };
}

function positionFor(rect) {
  const anchor = rect || { x: 0, y: 0, width: 0, height: 0 };
  const display = screen.getDisplayMatching({
    x: anchor.x,
    y: anchor.y,
    width: Math.max(1, anchor.width || 1),
    height: Math.max(1, anchor.height || 1),
  });
  const work = display.workArea;
  const gap = 12;
  const width = Math.min(CARD_WIDTH, work.width - 8);
  const height = Math.min(CARD_HEIGHT, work.height - 8);
  let x;
  let y;
  if (anchor.x + anchor.width + gap + width <= work.x + work.width) {
    x = anchor.x + anchor.width + gap;
    y = anchor.y;
  } else if (anchor.x - gap - width >= work.x) {
    x = anchor.x - gap - width;
    y = anchor.y;
  } else if (anchor.y + anchor.height + gap + height <= work.y + work.height) {
    x = anchor.x + anchor.width - width;
    y = anchor.y + anchor.height + gap;
  } else {
    x = anchor.x + anchor.width - width;
    y = anchor.y - gap - height;
  }
  const clamped = clampToWorkArea(x, y, width, height, work);
  return { ...clamped, width, height, display };
}

class ResultWindow {
  constructor() {
    this.win = null;
    this.record = null;
    this.pinned = true;
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: true,
      minWidth: 360,
      minHeight: 320,
      maxWidth: 780,
      maxHeight: 900,
      skipTaskbar: true,
      show: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setSkipTaskbar(true);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'result', 'index.html'));
    win.on('closed', () => {
      this.win = null;
      this.record = null;
    });
    this.win = win;
    return win;
  }

  show(record, anchorRect) {
    const win = this.ensure();
    this.record = record;
    this.pinned = true;
    win.setAlwaysOnTop(true, 'floating');
    const target = positionFor(anchorRect);
    win.setBounds({
      x: target.x,
      y: target.y,
      width: target.width,
      height: target.height,
    });
    const send = () => {
      if (!win.isDestroyed()) win.webContents.send('result:show', this.record);
    };
    if (win.webContents.isLoadingMainFrame()) {
      win.webContents.once('did-finish-load', send);
    } else {
      send();
    }
    win.show();
    win.focus();
    return win;
  }

  update(record) {
    this.record = record;
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('result:state', record);
    }
  }

  delta(field, delta) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('result:delta', { field, delta });
    }
  }

  notify(channel, payload) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(channel, payload);
    }
  }

  togglePin() {
    this.pinned = !this.pinned;
    if (this.win && !this.win.isDestroyed()) {
      this.win.setAlwaysOnTop(this.pinned, this.pinned ? 'floating' : 'normal');
    }
    return this.pinned;
  }

  hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
    this.win = null;
    this.record = null;
  }

  isOpen() {
    return Boolean(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }
}

module.exports = { ResultWindow, positionFor };
