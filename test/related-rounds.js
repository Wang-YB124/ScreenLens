const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isAllowedSearchUrl } = require('../src/core/search');

const APP_PORT = Number(process.env.APP_PORT || 9223);
const PANEL_PORT = Number(process.env.PANEL_PORT || 9228);
const OUT = path.resolve(process.env.OUT_DIR || 'test/shots/related-rounds');
const SUMMARY_PATH = path.resolve(process.env.SUMMARY_PATH || 'test/related-rounds-summary.json');
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

async function waitRelated(result, timeout = 35000) {
  const started = Date.now();
  let rec = null;
  let nudged = false;
  while (Date.now() - started < timeout) {
    try {
      const raw = await result.eval(`window.screenlens.invoke('result:get').then((r) => JSON.stringify(r))`);
      rec = raw ? JSON.parse(raw) : null;
      const status = rec?.related?.status;
      if (status === 'done' || status === 'error') return rec;
      if (!nudged && status === 'idle' && Date.now() - started > 2500) {
        nudged = true;
        try {
          await result.eval(`window.screenlens.invoke('action:related').then(() => 'ok')`);
        } catch {}
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

const PAGE1 = [
  {
    label: '01 \u00b7 SCIENCE EN',
    cls: 'science',
    text: 'Photosynthesis converts light energy into chemical energy in chloroplasts and releases oxygen.',
  },
  {
    label: '02 \u00b7 \u4e2d\u6587\u6280\u672f\u8bf4\u660e',
    cls: 'cn',
    text: '\u5b9e\u65f6\u5b57\u5e55\u4f1a\u6301\u7eed\u622a\u53d6\u5c4f\u5e55\u4e0a\u7684\u6587\u5b57\uff0c\n\u5e76\u5728\u5185\u5bb9\u53d8\u5316\u65f6\u81ea\u52a8\u5237\u65b0\u7ffb\u8bd1\u7ed3\u679c\u3002',
  },
  {
    label: '03 \u00b7 PYTHON',
    cls: 'code',
    text: 'def total(prices):\n    return sum(p for p in prices if p > 0)\n# keep only positive prices',
  },
  {
    label: '04 \u00b7 CALCULUS',
    cls: 'math',
    text: "Derivative: f'(x) = 3x\u00b2 - 4x + 1\nIntegral from 0 to 1:\n\u222b (3x\u00b2 - 4x + 1) dx = 0",
  },
  {
    label: '05 \u00b7 PHYSICS',
    cls: 'science',
    text: "Newton's second law: F = ma.\nA 12 N net force on a 3 kg mass\nproduces an acceleration of 4 m/s\u00b2.",
  },
];

const PAGE2 = [
  {
    label: '06 \u00b7 HISTORY',
    cls: '',
    text: 'Albert Einstein was a German-born theoretical physicist, widely known for the theory of relativity. He received the Nobel Prize in Physics in 1921.',
  },
  {
    label: '07 \u00b7 MEDICAL LAW',
    cls: '',
    text: 'Under medical law, informed consent is required before treatment. Patients must understand the risks, benefits, and alternatives before signing the consent form.',
  },
  {
    label: '08 \u00b7 NEWS',
    cls: '',
    text: 'OpenAI announced a new model on Tuesday, saying it improves reasoning while reducing latency for developers.',
  },
  {
    label: '09 \u00b7 PRODUCT',
    cls: '',
    text: 'The AeroBook 14 weighs 1.2 kg, offers 18 hours of battery life, and starts at $899.',
  },
  {
    label: '10 \u00b7 ENGLISH LONG',
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
  let panelInfo = null;
  const applyPage = async (items) => {
    await panel.eval(`(() => {
      const items = ${JSON.stringify(items)};
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
    console.log('PANEL_PAGE', JSON.stringify(panelInfo.blocks.map((b) => b.label)));
  };
  await applyPage(PAGE1);
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
    { n: 1, block: 0, ai: true, model: 'mock-science', expected: 'science', topic: '', sites: ['scholar', 'wikipedia'], keywords: ['photosynthesis', 'chloroplast', 'oxygen'], source: 'ai', label: 'English science' },
    { n: 2, block: 1, ai: false, expected: 'general', topic: '', sites: ['wikipedia', 'bing', 'baidu'], keywords: ['实时字幕', '自动刷新'], source: 'rules', label: 'Chinese tech note' },
    { n: 3, block: 2, ai: true, model: 'mock-python', expected: 'code', topic: '', sites: ['stackoverflow', 'github'], keywords: ['python', 'total', 'generator'], source: 'ai', label: 'Python' },
    { n: 4, block: 3, ai: true, model: 'mock-calculus', expected: 'math', topic: '', sites: ['scholar', 'wikipedia', 'wolfram'], keywords: ['derivative', 'integral'], source: 'ai', label: 'Calculus' },
    { n: 5, block: 4, ai: true, model: 'mock-physics', expected: 'science', topic: '', sites: ['scholar', 'wikipedia'], keywords: ['newton', 'acceleration', 'force'], source: 'ai', label: 'Physics' },
    { n: 6, block: 0, ai: true, model: 'mock-bad-keywords', expected: 'science', topic: 'history', sites: ['wikipedia', 'bing'], keywords: ['einstein', 'relativity', 'physicist'], source: 'rules', label: 'History figure', page: 2 },
    { n: 7, block: 1, ai: true, model: 'mock-medical', expected: 'general', topic: 'medical', sites: ['pubmed', 'wikipedia', 'bing'], keywords: ['medical law', 'informed consent', 'treatment'], source: 'ai', label: 'Medical law', page: 2 },
    { n: 8, block: 2, ai: true, model: 'mock-news', expected: 'general', topic: 'news', sites: ['bingnews', 'wikipedia', 'bing'], keywords: ['openai', 'reasoning', 'latency'], source: 'ai', label: 'News', page: 2 },
    { n: 9, block: 3, ai: true, model: 'mock-product', expected: 'general', topic: 'product', sites: ['bing', 'wikipedia'], keywords: ['aerobook', 'battery', 'price'], source: 'ai', label: 'Product', page: 2 },
    { n: 10, block: 4, ai: true, model: 'mock-en-long', expected: 'general', topic: '', sites: ['wikipedia', 'bing'], keywords: ['screen translator', 'technical terms', 'idioms'], source: 'ai', label: 'English long', page: 2 },
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
        await applyPage(PAGE2);
        page2Applied = true;
      }
      const patch = round.ai
        ? {
          provider: { baseUrl: 'http://127.0.0.1:11435/v1', model: round.model || 'mock', clearApiKey: true },
          translateEngine: 'ai',
          contentDomain: 'auto',
          vision: { enabled: false },
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

      await result.eval(`document.querySelector('[data-pane="related"]').click(); 'clicked'`);
      const relRec = await waitRelated(result);
      console.log('RELATED_DONE', round.n, relRec?.related?.status, relRec?.related?.source);
      await sleep(250);
      const relatedFile = path.join(OUT, `related-${round.n}-related.png`);
      await result.screenshot(relatedFile);
      const relatedShot = shotInfo(relatedFile);
      console.log('SHOT_RELATED', round.n, relatedShot.bytes);

      const uiRelated = JSON.parse(await result.eval(`JSON.stringify({
        heading: document.querySelector('#pane-related .related-head h3')?.textContent || '',
        sourceText: document.querySelector('#pane-related .related-source')?.textContent || '',
        chips: document.querySelectorAll('#pane-related .related-keyword').length,
        cards: document.querySelectorAll('#pane-related .related-link').length,
        notice: document.querySelector('#pane-related .notice')?.textContent || '',
        active: Boolean(document.querySelector('.tab[data-pane="related"]')?.classList.contains('active')),
        error: document.querySelector('#pane-related .error-message')?.textContent || ''
      })`));

      await result.eval(`document.querySelector('[data-pane="explanation"]').click(); 'clicked'`);
      const exRec = await waitExplanation(result);
      console.log('EXPLAIN_DONE', round.n, exRec?.explanation?.status);
      const ui2 = JSON.parse(await result.eval(`JSON.stringify({
        explanationText: document.getElementById('pane-explanation').innerText.slice(0, 600),
        katex: document.querySelectorAll('#pane-explanation .katex').length,
        codeBlocks: document.querySelectorAll('#pane-explanation .code-block').length,
        hljs: document.querySelectorAll('#pane-explanation .hljs-keyword, #pane-explanation .hljs-title, #pane-explanation .hljs-string, #pane-explanation .hljs-number').length,
        cta: document.querySelector('#pane-explanation .cta-card')?.innerText.slice(0, 180) || '',
        error: document.querySelector('#pane-explanation .error-message')?.textContent || ''
      })`));

      const related = exRec?.related || {};
      const keywords = Array.isArray(related.keywords) ? related.keywords : [];
      const links = Array.isArray(related.links) ? related.links : [];
      const keywordText = keywords.join(' | ').toLowerCase();
      const siteKeys = links.map((link) => link.key);
      const linksOk = links.length >= 2 && links.every((link) => (
        /^https:\/\//.test(link.url)
        && !/\s/.test(link.url)
        && !/[\u3400-\u9fff]/.test(link.url)
        && isAllowedSearchUrl(link.url)
      ));
      const expectedSourceText = related.source === 'ai' ? 'AI 提取' : '本地提取';
      const checks = {
        source: String(exRec?.source || '').length > 10,
        domain: (exRec?.meta?.detectedDomain || exRec?.meta?.domain) === round.expected,
        translation: exRec?.translation?.status === 'done',
        explanation: round.ai
          ? exRec?.explanation?.status === 'done'
          : exRec?.explanation?.status === 'unavailable',
        related: related.status === 'done' && keywords.length >= 2 && links.length === round.sites.length,
        keywords: round.keywords.every((word) => keywordText.includes(word.toLowerCase())),
        sites: siteKeys.join(',') === round.sites.join(','),
        links: linksOk,
        topic: (related.topic || '') === round.topic,
        relatedSource: related.source === round.source && (round.n === 6 ? Boolean(related.notice) : true),
        relatedUi: uiRelated.heading === '相关知识'
          && uiRelated.chips === keywords.length
          && uiRelated.cards === links.length
          && uiRelated.active === true
          && uiRelated.sourceText === expectedSourceText,
        renderCode: round.expected === 'code' ? ui1.codeBlocks >= 1 && ui1.hljs > 0 : true,
        renderMath: round.expected === 'math' ? ui1.katex > 0 : true,
        shots: translationShot.sha256 !== relatedShot.sha256,
        uiError: !ui1.error && !ui2.error && !uiRelated.error,
      };
      const shots = { translation: translationShot, related: relatedShot };
      const item = {
        round: round.n,
        label: round.label,
        mode: round.ai ? 'ai' : 'free',
        expectedDomain: round.expected,
        expectedTopic: round.topic,
        expectedKeywords: round.keywords,
        expectedSites: round.sites,
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
        related: {
          status: related.status,
          keywords,
          links,
          source: related.source,
          notice: related.notice || '',
          topic: related.topic || '',
        },
        shots,
        checks,
        pass: Object.values(checks).every(Boolean),
        ui1,
        uiRelated,
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
        relatedStatus: item.related.status,
        relatedSource: item.related.source,
        topic: item.related.topic,
        keywords: item.related.keywords,
        sites: item.related.links.map((link) => link.key),
        relatedNotice: item.related.notice,
        katex: ui1.katex + ui2.katex,
        code: ui1.codeBlocks + ui2.codeBlocks,
        hljs: ui1.hljs + ui2.hljs,
        error: ui1.error || ui2.error || uiRelated.error,
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

  const uniqueLinks = new Map();
  for (const item of summary) {
    for (const link of item.related?.links || []) {
      const key = `${link.key}|${link.host}`;
      if (!uniqueLinks.has(key)) uniqueLinks.set(key, link);
    }
  }
  const httpChecks = await Promise.all([...uniqueLinks.values()].map(async (link) => {
    try {
      const res = await fetch(link.url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
        headers: { 'User-Agent': 'Mozilla/5.0 ScreenLensQA' },
      });
      try { await res.body?.cancel(); } catch {}
      return { key: link.key, site: link.site, url: link.url, ok: true, status: res.status };
    } catch (err) {
      return { key: link.key, site: link.site, url: link.url, ok: false, error: err.message };
    }
  }));
  const passCount = summary.filter((item) => item.pass).length;
  const summaryDoc = {
    generatedAt: new Date().toISOString(),
    passCount,
    total: summary.length,
    rounds: summary,
    httpChecks,
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summaryDoc, null, 2), 'utf8');
  console.log('HTTP_CHECKS', JSON.stringify(httpChecks));
  console.log('SUMMARY_WRITTEN', SUMMARY_PATH);
  console.log('PASS_COUNT', passCount, '/', summary.length);
  home.close();
  panel.close();
}

main().catch((err) => {
  console.error('FIVE_ROUNDS_ERR', err.stack || err.message);
  process.exitCode = 1;
});
