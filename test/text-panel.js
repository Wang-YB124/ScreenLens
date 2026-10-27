const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const os = require('os');

app.setName('ScreenLensTextPanel');
app.setPath('userData', path.join(os.tmpdir(), 'screenlens-text-panel'));
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay();
  const width = 900;
  const height = 300;
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + 150);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#10151c',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'text-panel.html'));
  win.show();
  win.focus();
  console.log('PANEL_BOUNDS', JSON.stringify({ x, y, width, height }));
  setTimeout(() => app.quit(), 180000);
});
