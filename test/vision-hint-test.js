const fs = require('fs');
const path = require('path');

const APP_PORT = 9223;
const PANEL_PORT = 9228;
const OUT = path.resolve('test/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

async function waitFor(port, predicate, timeout = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const found = predicate(await targets(port));
      if (found) return found;
    } catch {}
    await sleep(300);
  }
  throw new Error('timeout waiting target');
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
  const panelTarget = await waitFor(PANEL_PORT, (list) => list.find((t) => t.url.includes('scenario-panel.html')));
  const panel = await new CDP(panelTarget).connect();
  const info = JSON.parse(await panel.eval(`(() => {
    const el = document.querySelectorAll('.scenario .text')[2];
    const r = el.getBoundingClientRect();
    return JSON.stringify({ screenX, screenY, x: r.x, y: r.y, width: r.width, height: r.height });
  })()`));

  const homeTarget = await waitFor(APP_PORT, (list) => list.find((t) => t.url.includes('/home/index.html')));
  const home = await new CDP(homeTarget).connect();
  const resultTarget = await waitFor(APP_PORT, (list) => list.find((t) => t.url.includes('/result/index.html')));
  const result = await new CDP(resultTarget).connect();
  const beforeRaw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
  const baselineId = beforeRaw ? JSON.parse(beforeRaw)?.id : null;
  console.log('BASELINE', baselineId);

  await home.eval(`document.getElementById('btn-select').click(); 'clicked'`);
  const overlayTarget = await waitFor(APP_PORT, (list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
  const overlay = await new CDP(overlayTarget).connect();
  await sleep(600);

  const x1 = Math.round(info.screenX + info.x + 2);
  const y1 = Math.round(info.screenY + info.y + 1);
  const x2 = Math.round(info.screenX + info.x + info.width - 2);
  const y2 = Math.round(info.screenY + info.y + info.height - 1);
  await overlay.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await overlay.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x1 + ((x2 - x1) * i) / 10,
      y: y1 + ((y2 - y1) * i) / 10,
      button: 'left',
      buttons: 1,
    });
    await sleep(20);
  }
  await overlay.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
  overlay.close();

  let record = null;
  const started = Date.now();
  while (Date.now() - started < 30000) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      record = raw ? JSON.parse(raw) : null;
      if (record && record.id !== baselineId && record.translation?.status === 'done') break;
    } catch {}
    await sleep(400);
  }
  const hint = JSON.parse(await result.eval(`JSON.stringify({
    visible: !!document.querySelector('#pane-translation .vision-hint'),
    text: document.querySelector('#pane-translation .vision-hint')?.innerText || '',
    trigger: document.querySelector('#pane-translation .vision-hint .btn-small')?.textContent || '',
    domain: document.querySelector('#domain-select')?.value,
    visionChip: !document.getElementById('foot-vision').classList.contains('hidden')
  })`));
  console.log('HINT_BEFORE', JSON.stringify(hint, null, 2));
  await result.screenshot(path.join(OUT, 'hint-before.png'));

  if (!hint.visible) throw new Error('vision hint not visible');
  await result.eval(`document.querySelector('#pane-translation .vision-hint .btn-small').click(); 'clicked'`);

  let after = null;
  const started2 = Date.now();
  while (Date.now() - started2 < 30000) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      after = raw ? JSON.parse(raw) : null;
      if (after && after.translation?.status === 'done' && after.meta?.visionUsed) break;
    } catch {}
    await sleep(500);
  }
  const afterUi = JSON.parse(await result.eval(`JSON.stringify({
    hintVisible: !!document.querySelector('#pane-translation .vision-hint'),
    visionChip: !document.getElementById('foot-vision').classList.contains('hidden'),
    codeBlocks: document.querySelectorAll('#pane-translation .code-block').length,
    hljs: document.querySelectorAll('#pane-translation .hljs-keyword, #pane-translation .hljs-title, #pane-translation .hljs-string, #pane-translation .hljs-number').length
  })`));
  console.log('AFTER', JSON.stringify({
    translationStatus: after?.translation?.status,
    provider: after?.translation?.provider,
    visionUsed: after?.meta?.visionUsed,
    visionEnabled: after?.meta?.visionEnabled,
    translation: (after?.translation?.text || '').slice(0, 160),
    afterUi,
  }, null, 2));
  await result.screenshot(path.join(OUT, 'hint-enabled.png'));
  result.close();
  home.close();
  panel.close();
}

main().catch((err) => {
  console.error('HINT_ERR', err.stack || err.message);
  process.exitCode = 1;
});
