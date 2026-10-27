const fs = require('fs');
const path = require('path');

const APP_PORT = Number(process.env.APP_PORT || 9223);
const PANEL_PORT = Number(process.env.PANEL_PORT || 9228);
const OUT = path.resolve('test/shots');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function targets(port) {
  return (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
}

async function waitFor(port, predicate, timeout = 25000, interval = 300) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const found = predicate(await targets(port));
      if (found) return found;
    } catch {}
    await sleep(interval);
  }
  throw new Error(`timeout waiting target on port ${port}`);
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

async function drag(overlay, x1, y1, x2, y2) {
  await overlay.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: x1, y: y1, button: 'left', clickCount: 1,
  });
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
  await overlay.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: x2, y: y2, button: 'left', clickCount: 1,
  });
}

async function waitRecord(result, lastId, timeout = 45000) {
  const started = Date.now();
  let rec = null;
  while (Date.now() - started < timeout) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      rec = raw ? JSON.parse(raw) : null;
      if (rec && rec.id !== lastId && ['done', 'error', 'empty'].includes(rec.translation?.status)) {
        return rec;
      }
    } catch {}
    await sleep(400);
  }
  return rec;
}

async function waitExplanation(result, timeout = 40000) {
  const started = Date.now();
  let rec = null;
  while (Date.now() - started < timeout) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      rec = raw ? JSON.parse(raw) : null;
      if (rec && ['dictionary', 'unavailable', 'done', 'error'].includes(rec.explanation?.status)) {
        return rec;
      }
    } catch {}
    await sleep(400);
  }
  return rec;
}

async function main() {
  const panelTarget = await waitFor(PANEL_PORT, (list) => list.find((t) => t.url.includes('scenario-panel.html')));
  const panel = await new CDP(panelTarget).connect();
  const panelInfo = JSON.parse(await panel.eval(`(() => {
    const blocks = [...document.querySelectorAll('.scenario')].map((el, index) => {
      const text = el.querySelector('.text');
      const rect = text.getBoundingClientRect();
      return { round: index + 1, label: el.querySelector('.label')?.textContent.trim(), text: text.innerText, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    return JSON.stringify({ screenX, screenY, innerWidth, innerHeight, blocks });
  })()`));
  console.log('PANEL', JSON.stringify({ screenX: panelInfo.screenX, screenY: panelInfo.screenY, blocks: panelInfo.blocks.length }));
  if (panelInfo.blocks.length !== 5) throw new Error('scenario panel not ready');

  const homeTarget = await waitFor(APP_PORT, (list) => list.find((t) => t.url.includes('/home/index.html')));
  const home = await new CDP(homeTarget).connect();
  await home.eval(`(async () => {
    const start = document.getElementById('onboarding-start');
    if (start) start.click();
    await window.screenlens.invoke('settings:update', { onboarded: true });
    await new Promise((r) => setTimeout(r, 500));
    return 'ready';
  })()`);

  const rounds = [
    { n: 1, block: 0, ai: false, vision: false, label: 'English prose' },
    { n: 2, block: 1, ai: false, vision: false, label: '中文散文' },
    { n: 3, block: 2, ai: true, vision: false, label: 'Code' },
    { n: 4, block: 3, ai: true, vision: true, label: 'Math' },
    { n: 5, block: 4, ai: true, vision: false, label: 'Science' },
  ];

  let result = null;
  let lastId = null;
  const summary = [];

  try {
    const existing = await targets(APP_PORT);
    const rt = existing.find((t) => t.url.includes('/result/index.html'));
    if (rt) {
      result = await new CDP(rt).connect();
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      const old = raw ? JSON.parse(raw) : null;
      lastId = old?.id || null;
      console.log('BASELINE_RESULT', lastId);
    }
  } catch {}

  for (const round of rounds) {
    try {
      const patch = round.ai
        ? {
          provider: { baseUrl: 'http://127.0.0.1:11435/v1', model: 'mock', clearApiKey: true },
          translateEngine: 'ai',
          contentDomain: 'auto',
          vision: { enabled: round.vision },
          freeTranslation: true,
        }
        : {
          provider: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', clearApiKey: true },
          translateEngine: 'auto',
          contentDomain: 'auto',
          vision: { enabled: false },
          freeTranslation: true,
        };
      await home.eval(`window.screenlens.invoke('settings:update', ${JSON.stringify(patch)}).then(() => 'ok')`);
      await sleep(350);
      await home.eval(`document.getElementById('btn-select').click(); 'clicked'`);

      const overlayTarget = await waitFor(APP_PORT, (list) => list.find((t) => t.url.includes('/overlay/index.html')), 15000);
      const overlay = await new CDP(overlayTarget).connect();
      await sleep(600);
      const b = panelInfo.blocks[round.block];
      const x1 = Math.round(panelInfo.screenX + b.x + 2);
      const y1 = Math.round(panelInfo.screenY + b.y + 1);
      const x2 = Math.round(panelInfo.screenX + b.x + b.width - 2);
      const y2 = Math.round(panelInfo.screenY + b.y + b.height - 1);
      console.log(`ROUND ${round.n} drag ${x1},${y1} -> ${x2},${y2} | ${JSON.stringify(b.text.slice(0, 70))}`);
      await drag(overlay, x1, y1, x2, y2);
      overlay.close();

      if (!result) {
        const resultTarget = await waitFor(APP_PORT, (list) => list.find((t) => t.url.includes('/result/index.html')), 25000);
        result = await new CDP(resultTarget).connect();
      }
      const rec = await waitRecord(result, lastId);
      lastId = rec?.id || lastId;
      await result.screenshot(path.join(OUT, `round-${round.n}-translation.png`));

      const ui1 = JSON.parse(await result.eval(`JSON.stringify({
        translationText: document.getElementById('pane-translation').innerText.slice(0, 600),
        katex: document.querySelectorAll('#pane-translation .katex').length,
        codeBlocks: document.querySelectorAll('#pane-translation .code-block').length,
        hljs: document.querySelectorAll('#pane-translation .hljs-keyword, #pane-translation .hljs-title, #pane-translation .hljs-string, #pane-translation .hljs-number').length,
        vision: !document.getElementById('foot-vision').classList.contains('hidden'),
        domainSelect: document.getElementById('domain-select').value,
        autoOption: document.querySelector('#domain-select option[value="auto"]')?.textContent,
        sourceMeta: document.getElementById('source-meta').textContent,
        error: document.querySelector('#pane-translation .error-message')?.textContent || ''
      })`));

      await result.eval(`document.querySelector('[data-pane="explanation"]').click(); 'clicked'`);
      const exRec = await waitExplanation(result);
      await result.screenshot(path.join(OUT, `round-${round.n}-explanation.png`));

      const ui2 = JSON.parse(await result.eval(`JSON.stringify({
        explanationText: document.getElementById('pane-explanation').innerText.slice(0, 600),
        katex: document.querySelectorAll('#pane-explanation .katex').length,
        codeBlocks: document.querySelectorAll('#pane-explanation .code-block').length,
        hljs: document.querySelectorAll('#pane-explanation .hljs-keyword, #pane-explanation .hljs-title, #pane-explanation .hljs-string, #pane-explanation .hljs-number').length,
        cta: document.querySelector('#pane-explanation .cta-card')?.innerText.slice(0, 180) || '',
        error: document.querySelector('#pane-explanation .error-message')?.textContent || ''
      })`));

      const item = {
        round: round.n,
        label: round.label,
        mode: round.ai ? 'ai' : 'free',
        vision: round.vision,
        source: exRec?.source || '',
        sourceLang: exRec?.meta?.sourceLang,
        targetLang: exRec?.meta?.targetLang,
        domain: exRec?.meta?.domain,
        detected: exRec?.meta?.detectedDomain,
        domainMode: exRec?.meta?.domainMode,
        provider: exRec?.translation?.provider,
        translationStatus: exRec?.translation?.status,
        translation: exRec?.translation?.text || '',
        translationNotice: exRec?.translation?.notice || '',
        explanationStatus: exRec?.explanation?.status,
        explanation: exRec?.explanation?.text || '',
        explanationNotice: exRec?.explanation?.notice || '',
        visionUsed: exRec?.meta?.visionUsed,
        ui1,
        ui2,
      };
      summary.push(item);
      console.log('ROUND_RESULT', JSON.stringify({
        round: item.round,
        label: item.label,
        source: item.source,
        domain: item.domain,
        detected: item.detected,
        provider: item.provider,
        translationStatus: item.translationStatus,
        translation: item.translation.slice(0, 160),
        explanationStatus: item.explanationStatus,
        explanation: item.explanation.slice(0, 140),
        vision: item.visionUsed,
        katex: ui1.katex + ui2.katex,
        code: ui1.codeBlocks + ui2.codeBlocks,
        hljs: ui1.hljs + ui2.hljs,
        error: ui1.error || ui2.error,
      }, null, 2));
    } catch (err) {
      console.error('ROUND_ERROR', round.n, err.message);
      summary.push({ round: round.n, label: round.label, error: err.message });
    }
  }

  fs.writeFileSync(path.resolve('test/rounds-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log('SUMMARY_WRITTEN test/rounds-summary.json');
  result?.close();
  home.close();
  panel.close();
}

main().catch((err) => {
  console.error('FIVE_ROUNDS_ERR', err.stack || err.message);
  process.exitCode = 1;
});
