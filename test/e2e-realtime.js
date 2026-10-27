const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || '9223';
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
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function main() {
  const homeTarget = await waitFor((list) => list.find((t) => t.url.includes('/home/index.html')));
  const home = await new CDP(homeTarget).connect();
  const res = await home.eval(`window.screenlens.invoke('action:realtime').then((r) => JSON.stringify(r))`);
  console.log('ACTION', res);

  const overlayTarget = await waitFor((list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
  const overlay = await new CDP(overlayTarget).connect();
  await new Promise((r) => setTimeout(r, 600));
  const info = JSON.parse(await overlay.eval(`JSON.stringify({screenX, screenY, innerWidth, innerHeight, ready: !!document.getElementById('scene').style.backgroundImage})`));
  console.log('OVERLAY', info);

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

  const rtTarget = await waitFor((list) => list.find((t) => t.url.includes('/realtime/index.html')), 20000);
  const rt = await new CDP(rtTarget).connect();
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 1400));
    try {
      const value = await rt.eval(`JSON.stringify({screenX,screenY,w:innerWidth,h:innerHeight,original:document.getElementById('original').textContent,translated:document.getElementById('translated').textContent,cls:document.getElementById('translated').className,direction:document.getElementById('dir').textContent,provider:document.getElementById('provider').textContent})`);
      samples.push(JSON.parse(value));
    } catch (err) {
      samples.push({ error: err.message });
    }
  }
  console.log('SAMPLES');
  for (const sample of samples) console.log(JSON.stringify(sample));
  await rt.screenshot(path.join(OUT, 'realtime.png'));
  console.log('SHOT', path.join(OUT, 'realtime.png'));
  rt.close();

  const stop = await home.eval(`window.screenlens.invoke('action:stop-realtime').then((r) => JSON.stringify(r))`);
  console.log('STOP', stop);
  home.close();
}

main().catch((err) => { console.error('RT_ERR', err.message); process.exitCode = 1; });
