const { execFile } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'audio', 'audio-device.ps1');
const CACHE_MS = 5000;
let cache = { at: 0, value: null };
let pending = null;

function getOutputDeviceState({ force = false, timeout = 4000 } = {}) {
  if (!force && cache.value && Date.now() - cache.at < CACHE_MS) {
    return Promise.resolve(cache.value);
  }
  if (pending) return pending;
  pending = new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT],
      { windowsHide: true, timeout },
      (err, stdout) => {
        pending = null;
        let value = null;
        try {
          value = JSON.parse(String(stdout || '').trim());
        } catch {
          value = { ok: false, error: err ? String(err.message || err) : '设备状态读取失败' };
        }
        cache = { at: Date.now(), value };
        resolve(value);
      },
    );
  });
  return pending;
}

module.exports = { getOutputDeviceState };
