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
    return file;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function pollRecord(result, predicate, timeout = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      last = raw ? JSON.parse(raw) : null;
      if (last && predicate(last)) return last;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  return last;
}

async function main() {
  const homeTarget = await waitFor((list) => list.find((t) => t.url.includes('/home/index.html')));
  const home = await new CDP(homeTarget).connect();
  const cfg = await home.eval(`window.screenlens.invoke('settings:update', {provider: {baseUrl: 'http://127.0.0.1:11435/v1', model: 'mock', clearApiKey: true}, translateEngine: 'ai'}).then((r) => JSON.stringify({ok: r.ok, provider: r.state.provider, settings: r.settings.provider, engine: r.state.settings.translateEngine}))`);
  console.log('CFG', cfg);
  const test = await home.eval(`window.screenlens.invoke('provider:test', {baseUrl: 'http://127.0.0.1:11435/v1', model: 'mock'}).then((r) => JSON.stringify(r))`);
  console.log('TEST', test);

  await home.eval(`document.getElementById('btn-select').click(); 'clicked'`);
  home.close();

  const overlayTarget = await waitFor((list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
  const overlay = await new CDP(overlayTarget).connect();
  await new Promise((r) => setTimeout(r, 600));
  const startX = 450;
  const startY = 215;
  const endX = 1280;
  const endY = 286;
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
  const done = await pollRecord(result, (r) => r.translation?.status === 'done' || r.translation?.status === 'error');
  console.log('AI_TRANSLATION', JSON.stringify({
    source: done?.source,
    status: done?.translation?.status,
    provider: done?.translation?.provider,
    engine: done?.engine,
    text: done?.translation?.text,
    error: done?.translation?.error,
    notice: done?.translation?.notice,
  }, null, 2));
  await result.screenshot(path.join(OUT, 'ai-translation.png'));

  await result.eval(`document.querySelector('[data-pane=explanation]').click(); 'explain'`);
  await new Promise((r) => setTimeout(r, 900));
  await result.screenshot(path.join(OUT, 'ai-explanation-streaming.png'));
  const mid = await pollRecord(result, (r) => r.explanation?.status === 'done' || r.explanation?.status === 'error', 30000);
  console.log('AI_EXPLANATION', JSON.stringify({
    status: mid?.explanation?.status,
    provider: mid?.explanation?.provider,
    text: mid?.explanation?.text,
    error: mid?.explanation?.error,
  }, null, 2));
  await result.screenshot(path.join(OUT, 'ai-explanation.png'));
  const ui = await result.eval(`document.getElementById('pane-explanation').innerText`);
  console.log('UI_EXPLANATION', String(ui).slice(0, 500));
  result.close();
}

main().catch((err) => { console.error('AI_ERR', err.message); process.exitCode = 1; });
