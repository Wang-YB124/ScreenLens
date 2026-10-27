async function targets() {
  return (await fetch('http://127.0.0.1:9223/json/list')).json();
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

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function drag(overlay, x1, y1, x2, y2) {
  await overlay.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await overlay.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: x1 + ((x2 - x1) * i) / 8,
      y: y1 + ((y2 - y1) * i) / 8,
      button: 'left',
      buttons: 1,
    });
    await new Promise((r) => setTimeout(r, 20));
  }
  await overlay.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1 });
}

async function main() {
  const homeTarget = await waitFor((list) => list.find((t) => t.url.includes('/home/index.html')));
  const home = await new CDP(homeTarget).connect();

  await home.eval(`document.getElementById('btn-select').click(); 'clicked'`);
  const overlayTarget = await waitFor((list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
  const overlay = await new CDP(overlayTarget).connect();
  await new Promise((r) => setTimeout(r, 600));
  await drag(overlay, 450, 215, 1280, 285);
  overlay.close();

  const resultTarget = await waitFor((list) => list.find((t) => t.url.includes('/result/index.html')), 20000);
  const result = await new CDP(resultTarget).connect();
  let record = null;
  const started = Date.now();
  while (Date.now() - started < 25000) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      record = raw ? JSON.parse(raw) : null;
      if (record && ['done', 'error', 'empty'].includes(record.translation?.status)) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log('RESULT', JSON.stringify({ source: record?.source, status: record?.translation?.status }));
  console.log('VISIBLE_BEFORE', await result.eval('document.visibilityState'));

  await home.eval(`document.getElementById('btn-select').click(); 'clicked-again'`);
  const overlay2Target = await waitFor((list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
  const overlay2 = await new CDP(overlay2Target).connect();
  await new Promise((r) => setTimeout(r, 500));
  console.log('VISIBLE_WHILE_SELECTING', await result.eval('document.visibilityState'));
  await overlay2.eval(`window.screenlens.send('overlay:cancel'); 'cancelled'`);
  overlay2.close();
  await new Promise((r) => setTimeout(r, 800));
  console.log('VISIBLE_AFTER_CANCEL', await result.eval('document.visibilityState'));
  result.close();
  home.close();
}

main().catch((err) => { console.error('CANCEL_ERR', err.message); process.exitCode = 1; });
