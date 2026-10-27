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
    const list = await targets();
    const found = predicate(list);
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
      if (msg.id) {
        const item = this.pending.get(msg.id);
        if (!item) return;
        this.pending.delete(msg.id);
        if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
        else item.resolve(msg.result);
      }
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
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'eval failed');
    }
    return result.result?.value;
  }

  async screenshot(file) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
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
  let info = null;
  for (let i = 0; i < 20; i += 1) {
    const metrics = await home.eval(`(() => {
      const r = document.querySelector('.hero h1').getBoundingClientRect();
      return JSON.stringify({screenX, screenY, innerWidth, innerHeight, dpr: devicePixelRatio, vis: document.visibilityState, h1: {x: r.x, y: r.y, width: r.width, height: r.height}});
    })()`);
    info = JSON.parse(metrics);
    if (info.h1.width > 50) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('HOME', JSON.stringify(info));

  await home.eval(`document.getElementById('btn-select').click(); 'clicked'`);
  home.close();

  const overlayTarget = await waitFor((list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
  const overlay = await new CDP(overlayTarget).connect();
  await new Promise((r) => setTimeout(r, 600));
  const overlayInfo = JSON.parse(await overlay.eval(`JSON.stringify({screenX, screenY, innerWidth, innerHeight, ready: !!document.getElementById('scene').style.backgroundImage})`));
  console.log('OVERLAY', overlayInfo);

  const startX = Math.round(info.screenX + info.h1.x + 12 - overlayInfo.screenX);
  const startY = Math.round(info.screenY + info.h1.y + 12 - overlayInfo.screenY);
  const endX = Math.round(info.screenX + info.h1.x + info.h1.width - 12 - overlayInfo.screenX);
  const endY = Math.round(info.screenY + info.h1.y + info.h1.height - 12 - overlayInfo.screenY);
  console.log('DRAG', startX, startY, '->', endX, endY);

  await overlay.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    const x = startX + ((endX - startX) * i) / 8;
    const y = startY + ((endY - startY) * i) / 8;
    await overlay.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await new Promise((r) => setTimeout(r, 25));
  }
  await overlay.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1 });
  overlay.close();

  const resultTarget = await waitFor((list) => list.find((t) => t.url.includes('/result/index.html')), 20000);
  const result = await new CDP(resultTarget).connect();
  const started = Date.now();
  let record = null;
  while (Date.now() - started < 30000) {
    try {
      record = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      if (record) {
        const parsed = JSON.parse(record);
        if (parsed && parsed.id && ['done', 'error', 'empty'].includes(parsed.translation?.status)) break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  const parsed = record ? JSON.parse(record) : null;
  console.log('RECORD', JSON.stringify({
    source: parsed?.source,
    status: parsed?.translation?.status,
    translation: parsed?.translation?.text,
    error: parsed?.translation?.error,
    provider: parsed?.translation?.provider,
    sourceLang: parsed?.meta?.sourceLang,
    targetLang: parsed?.meta?.targetLang,
  }, null, 2));
  const shot = path.join(OUT, 'e2e-result.png');
  await result.screenshot(shot);
  console.log('SHOT', shot);
  const uiText = await result.eval('document.body.innerText').catch(() => '');
  console.log('UI', String(uiText || '').slice(0, 400));
  result.close();
}

main().catch((err) => { console.error('E2E_ERR', err.message); process.exitCode = 1; });
