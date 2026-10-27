const fs = require('fs');

const port = process.argv[2] || '9223';
const expression = process.argv[3] || 'JSON.stringify({innerWidth,innerHeight,outerWidth,outerHeight,screenX,screenY,dpr:devicePixelRatio,visibility:document.visibilityState,title:document.title,ready:document.readyState,text:(document.body?document.body.innerText:"").slice(0,400)})';
const shotPath = process.argv[4];
const filter = process.argv[5] || '';

async function main() {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.includes(filter));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const events = [];

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, { resolve, reject });
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const item = pending.get(msg.id);
      if (!item) return;
      pending.delete(msg.id);
      if (msg.error) item.reject(new Error(JSON.stringify(msg.error)));
      else item.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown' || msg.method === 'Log.entryAdded') {
      events.push(msg);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  const result = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log('EVAL', JSON.stringify(result.result?.value ?? result.result, null, 2));

  if (shotPath) {
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
    console.log('SHOT', shotPath);
  }

  await new Promise((r) => setTimeout(r, 300));
  if (events.length) {
    console.log('EVENTS');
    for (const event of events.slice(0, 20)) console.log(JSON.stringify(event).slice(0, 1200));
  }
  ws.close();
}

main().catch((err) => { console.error('ERR', err.message); process.exitCode = 1; });
