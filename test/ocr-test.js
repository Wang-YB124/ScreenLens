const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const reqFile = path.join(os.tmpdir(), 'screenlens-ocr-qa.json');
const image = path.resolve(process.argv[2] || path.join(root, 'test/fixtures/ocr-sample.png'));
const lang = process.argv[3] || 'zh-Hans-CN';

async function main() {
  fs.writeFileSync(reqFile, JSON.stringify({ id: 1, image, lang }), 'utf8');
  const started = Date.now();
  const ps = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(root, 'src/ocr/ocr-worker.ps1'), reqFile,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  let buf = '';
  let done = false;
  const timer = setTimeout(() => {
    console.error('timeout');
    finish(1);
  }, 25000);

  function finish(code) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try { ps.stdin.write('quit\n'); } catch {}
    setTimeout(() => ps.kill(), 300);
    process.exitCode = code;
  }

  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('@@')) continue;
      const res = JSON.parse(line.slice(2));
      console.log('TOTAL_MS', Date.now() - started);
      if (!res.ok) {
        console.error('ERROR', JSON.stringify(res, null, 2));
        finish(1);
        return;
      }
      console.log('OCR_MS', res.ms);
      console.log('LANG', res.lang, 'SIZE', res.width, 'x', res.height);
      console.log('TEXT_START');
      console.log(res.text);
      console.log('TEXT_END');
      console.log('LINES', (res.lines || []).length);
      finish(0);
    }
  });
  ps.stderr.setEncoding('utf8');
  ps.stderr.on('data', (d) => process.stderr.write(d));
  ps.on('exit', (code) => {
    if (!done) {
      console.error('worker exited early', code, buf);
      finish(1);
    }
  });
  ps.stdin.write('run\n');
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
