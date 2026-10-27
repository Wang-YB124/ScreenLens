const { app, BrowserWindow, screen } = require('electron');
const path = require('path');
const os = require('os');

app.setName('ScreenLensScenarioPanel');
app.setPath('userData', path.join(os.tmpdir(), 'screenlens-scenario-panel'));
app.disableHardwareAcceleration();

app.whenReady().then(() => {
  const display = screen.getPrimaryDisplay();
  const width = Math.min(1180, display.workArea.width - 40);
  const height = Math.min(900, display.workArea.height - 40);
  const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
  const y = Math.round(display.workArea.y + 20);
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0d1218',
    webPreferences: { contextIsolation: true },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile(path.join(__dirname, 'scenario-panel.html'));
  win.show();
  console.log('SCENARIO_PANEL', JSON.stringify({ x, y, width, height }));
  setTimeout(() => app.quit(), 1800000);
});
