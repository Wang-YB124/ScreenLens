const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const os = require('os');

app.setName('ScreenLensWordPanel');
app.setPath('userData', path.join(os.tmpdir(), 'screenlens-word-panel'));
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay();
  const width = 820;
  const height = 260;
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + 220);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0e131a',
    webPreferences: { contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, 'word-panel.html'));
  win.show();
  console.log('WORD_PANEL', JSON.stringify({ x, y, width, height }));
  setTimeout(() => app.quit(), 150000);
});
