const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9224';
const OUT = path.resolve(process.argv[3] || 'test/shots');

async function targets() {
  return (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
}

async function waitFor(predicate, timeout = 20000, interval = 250) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const found = predicate(await targets());
    if (found) return found;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('timeout waiting for target');
}

class CDP {
  constructor(target) {
    this.target = target;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.target.webSocketDebuggerUrl);
    this.ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (!msg.id) return;
      const item = this.pending.get(msg.id);
      if (!item) return;
      this.pending.delete(msg.id);
      if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
      else item.resolve(msg.result);
    };
    await new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    return this;
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'eval failed');
    return result.result?.value;
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    return file;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function main() {
  const homeTarget = await waitFor((list) => list.find((t) => t.url.includes('/home/index.html')));
  const home = await new CDP(homeTarget).connect();
  await home.eval(`document.getElementById('btn-select').click(); 'clicked'`);
  home.close();

  const overlayTarget = await waitFor((list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
  const overlay = await new CDP(overlayTarget).connect();
  await new Promise((r) => setTimeout(r, 600));
  const startX = 450;
  const startY = 215;
  const endX = 1280;
  const endY = 285;
  await overlay.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await overlay.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX + ((endX - startX) * i) / 8,
      y: startY + ((endY - startY) * i) / 8,
      button: 'left',
      buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 20));
  }
  await overlay.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1 });
  overlay.close();

  const resultTarget = await waitFor((list) => list.find((t) => t.url.includes('/result/index.html')), 20000);
  const result = await new CDP(resultTarget).connect();
  let record = null;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      record = raw ? JSON.parse(raw) : null;
      if (record && ['done', 'error', 'empty'].includes(record.translation?.status)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('TRANSLATION', JSON.stringify({
    source: record?.source,
    status: record?.translation?.status,
    text: record?.translation?.text,
  }, null, 2));

  await result.screenshot(path.join(OUT, 'portable-result.png'));
  console.log('SHOT', path.join(OUT, 'portable-result.png'));
  result.close();
  home.close();
}

main().catch((err) => { console.error('SIMPLE_ERR', err.message); process.exitCode = 1; });
