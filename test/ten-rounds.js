const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_PORT = Number(process.env.APP_PORT || 9223);
const PANEL_PORT = Number(process.env.PANEL_PORT || 9228);
const OUT = path.resolve(process.env.OUT_DIR || 'test/shots/ten-rounds');
const SUMMARY_PATH = path.resolve(process.env.SUMMARY_PATH || 'test/ten-rounds-summary.json');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shotInfo(file) {
  const buf = fs.readFileSync(file);
  return {
    file: path.basename(file),
    bytes: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16),
  };
}

async function targets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  return res.json();
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
    this.closed = false;
  }

  failAll(message) {
    this.closed = true;
    for (const item of this.pending.values()) {
      try { item.reject(new Error(message)); } catch {}
    }
    this.pending.clear();
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
      this.ws.onerror = () => reject(new Error('cdp connect failed'));
    });
    this.ws.onclose = () => this.failAll('cdp closed');
    this.ws.onerror = () => this.failAll('cdp error');
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    return this;
  }

  send(method, params = {}, timeout = 30000) {
    if (this.closed) return Promise.reject(new Error('cdp closed'));
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`cdp timeout ${method}`));
      }, timeout);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
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
    const shot = await this.send('Page.captureScreenshot', { format: 'png' }, 20000);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
  }

  close() {
    this.closed = true;
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
  }).catch((err) => {
    console.log('DRAG_RELEASE_CLOSED', err.message);
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

async function connectResult() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const target = await waitFor(APP_PORT, (list) => list.find((t) => t.url.includes('/result/index.html')), 15000);
      return await new CDP(target).connect();
    } catch (err) {
      lastError = err;
      await sleep(600);
    }
  }
  throw lastError;
}

const PAGE2 = [
  {
    label: '06 · PYTHON',
    cls: 'code',
    text: 'def total(prices):\n    return sum(p for p in prices if p > 0)\n# keep only positive prices',
  },
  {
    label: '07 · CALCULUS',
    cls: 'math',
    text: "Derivative: f'(x) = 3x² - 4x + 1\nIntegral from 0 to 1:\n∫ (3x² - 4x + 1) dx = 0",
  },
  {
    label: '08 · PHYSICS',
    cls: 'science',
    text: "Newton's second law: F = ma.\nA 12 N net force on a 3 kg mass\nproduces an acceleration of 4 m/s².",
  },
  {
    label: '09 · 中文技术说明',
    cls: 'cn',
    text: '实时字幕会持续截取屏幕上的文字，\n并在内容变化时自动刷新翻译结果。',
  },
  {
    label: '10 · ENGLISH LONG',
    cls: '',
    text: 'A good screen translator keeps the layout of the original text, preserves technical terms, and explains idioms instead of translating them word by word.',
  },
];

async function main() {
  const panelTarget = await waitFor(PANEL_PORT, (list) => list.find((t) => t.url.includes('scenario-panel.html')));
  const panel = await new CDP(panelTarget).connect();
  const readPanel = async () => JSON.parse(await panel.eval(`(() => {
    const blocks = [...document.querySelectorAll('.scenario')].map((el, index) => {
      const text = el.querySelector('.text');
      const rect = text.getBoundingClientRect();
      return { round: index + 1, label: el.querySelector('.label')?.textContent.trim(), text: text.innerText, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
    return JSON.stringify({ screenX, screenY, innerWidth, innerHeight, blocks });
  })()`));
  let panelInfo = await readPanel();
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
    { n: 1, block: 0, ai: false, vision: false, expected: 'general', label: 'English prose' },
    { n: 2, block: 1, ai: false, vision: false, expected: 'general', label: '中文散文' },
    { n: 3, block: 2, ai: true, vision: false, model: 'mock', expected: 'code', label: 'JavaScript code' },
    { n: 4, block: 3, ai: true, vision: true, model: 'mock', expected: 'math', label: 'Math geometry' },
    { n: 5, block: 4, ai: true, vision: false, model: 'mock', expected: 'science', label: 'Science biology' },
    { n: 6, block: 0, ai: true, vision: false, model: 'mock-python', expected: 'code', label: 'Python code', page: 2 },
    { n: 7, block: 1, ai: true, vision: true, model: 'mock-calculus', expected: 'math', label: 'Math calculus', page: 2 },
    { n: 8, block: 2, ai: true, vision: false, model: 'mock-physics', expected: 'science', label: 'Science physics', page: 2 },
    { n: 9, block: 3, ai: false, vision: false, expected: 'general', label: '中文技术说明', page: 2 },
    { n: 10, block: 4, ai: true, vision: false, model: 'mock-en-long', expected: 'general', label: 'English long', page: 2 },
  ];

  let lastId = null;
  let page2Applied = false;
  const summary = [];

  try {
    const existing = await targets(APP_PORT);
    const rt = existing.find((t) => t.url.includes('/result/index.html'));
    if (rt) {
      const probe = await new CDP(rt).connect();
      try {
        const raw = await probe.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
        const old = raw ? JSON.parse(raw) : null;
        lastId = old?.id || null;
        console.log('BASELINE_RESULT', lastId);
      } finally {
        probe.close();
      }
    }
  } catch {}

  for (const round of rounds) {
    let result = null;
    try {
      if (round.page === 2 && !page2Applied) {
        await panel.eval(`(() => {
          const items = ${JSON.stringify(PAGE2)};
          const els = [...document.querySelectorAll('.scenario')];
          els.forEach((el, i) => {
            const s = items[i];
            el.className = 'scenario' + (s.cls ? ' ' + s.cls : '');
            el.querySelector('.label').textContent = s.label;
            el.querySelector('.text').textContent = s.text;
          });
          return els.length;
        })()`);
        await sleep(500);
        panelInfo = await readPanel();
        page2Applied = true;
        console.log('PANEL_PAGE2', JSON.stringify(panelInfo.blocks.map((b) => b.label)));
      }
      const patch = round.ai
        ? {
          provider: { baseUrl: 'http://127.0.0.1:11435/v1', model: round.model || 'mock', clearApiKey: true },
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

      result = await connectResult();
      const rec = await waitRecord(result, lastId);
      if (!rec || rec.id === lastId) throw new Error('no new result');
      lastId = rec.id;
      console.log('ROUND_REC', round.n, rec.id, rec.translation?.status);
      const translationFile = path.join(OUT, `round-${round.n}-translation.png`);
      await result.screenshot(translationFile);
      const translationShot = shotInfo(translationFile);
      console.log('SHOT_TRANSLATION', round.n, translationShot.bytes);

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
      console.log('EXPLAIN_CLICK', round.n);
      const exRec = await waitExplanation(result);
      console.log('EXPLAIN_DONE', round.n, exRec?.explanation?.status);
      const explanationFile = path.join(OUT, `round-${round.n}-explanation.png`);
      await result.screenshot(explanationFile);
      const explanationShot = shotInfo(explanationFile);
      console.log('SHOT_EXPLANATION', round.n, explanationShot.bytes);

      const ui2 = JSON.parse(await result.eval(`JSON.stringify({
        explanationText: document.getElementById('pane-explanation').innerText.slice(0, 600),
        katex: document.querySelectorAll('#pane-explanation .katex').length,
        codeBlocks: document.querySelectorAll('#pane-explanation .code-block').length,
        hljs: document.querySelectorAll('#pane-explanation .hljs-keyword, #pane-explanation .hljs-title, #pane-explanation .hljs-string, #pane-explanation .hljs-number').length,
        cta: document.querySelector('#pane-explanation .cta-card')?.innerText.slice(0, 180) || '',
        error: document.querySelector('#pane-explanation .error-message')?.textContent || ''
      })`));

      const shots = { translation: translationShot, explanation: explanationShot };
      const checks = {
        source: String(exRec?.source || '').length > 10,
        domain: (exRec?.meta?.detectedDomain || exRec?.meta?.domain) === round.expected,
        translation: exRec?.translation?.status === 'done',
        explanation: round.ai
          ? exRec?.explanation?.status === 'done'
          : exRec?.explanation?.status === 'unavailable',
        vision: !round.vision || exRec?.meta?.visionUsed === true,
        shots: translationShot.sha256 !== explanationShot.sha256,
        uiError: !ui1.error && !ui2.error,
      };
      const item = {
        round: round.n,
        label: round.label,
        mode: round.ai ? 'ai' : 'free',
        vision: round.vision,
        expectedDomain: round.expected,
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
        shots,
        checks,
        pass: Object.values(checks).every(Boolean),
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
        pass: item.pass,
        checks: item.checks,
      }, null, 2));
    } catch (err) {
      console.error('ROUND_ERROR', round.n, err.stack || err.message);
      summary.push({ round: round.n, label: round.label, error: err.message });
    } finally {
      result?.close();
    }
  }

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');
  console.log('SUMMARY_WRITTEN', SUMMARY_PATH);
  console.log('PASS_COUNT', summary.filter((item) => item.pass).length, '/', summary.length);
  home.close();
  panel.close();
}

main().catch((err) => {
  console.error('FIVE_ROUNDS_ERR', err.stack || err.message);
  process.exitCode = 1;
});
