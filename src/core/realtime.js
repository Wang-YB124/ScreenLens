const path = require('path');
const { dipToPhysicalRect } = require('./capture');
const { selectRegion } = require('../windows/overlay');
const { createRealtimeWindow } = require('../windows/realtimeWindow');
const { resolveDirection, translateFree, translateAI, LANG_NAMES } = require('./translate');
const { providerLabel } = require('./llm');
const { detectDomain, DOMAIN_LABELS } = require('./domain');

function normalizeKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
}

class RealtimeController {
  constructor({ settings, ocr, tempDir, onStateChange, notify, hideResult, restoreResult }) {
    this.settings = settings;
    this.ocr = ocr;
    this.tempDir = tempDir;
    this.hideResult = hideResult || (() => false);
    this.restoreResult = restoreResult || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.notify = notify || (() => {});
    this.active = false;
    this.selecting = false;
    this.busy = false;
    this.timer = null;
    this.win = null;
    this.abort = null;
    this.cache = new Map();
    this.lastKey = '';
    this.lastErrorAt = 0;
    this.tmpImage = path.join(tempDir, 'realtime.png');
  }

  isActive() {
    return this.active;
  }

  async start() {
    if (this.active || this.selecting) return;
    this.selecting = true;
    try {
      const hadResult = this.hideResult();
      const selection = await selectRegion();
      if (!selection) {
        if (hadResult) this.restoreResult();
        return;
      }
      if (this.active) return;
      const settings = this.settings.get();
      const canAI = this.settings.hasProvider();
      this.engine = settings.realtime.engine === 'free'
        ? 'free'
        : (canAI ? 'ai' : 'free');
      if (this.engine === 'free' && !settings.freeTranslation) {
        this.notify('实时字幕无法启动', '请先在设置中配置 AI 模型，或开启免费翻译通道。');
        return;
      }
      this.selection = selection;
      this.physical = dipToPhysicalRect(selection.rect);
      this.ocrLang = null;
      this.lastKey = '';
      this.lastText = '';
      this.emptyStreak = 0;
      this.aiFallbackNotified = false;
      this.cache.clear();
      this.active = true;
      this.win = createRealtimeWindow({ rect: selection.rect, settings });
      this.win.on('closed', () => {
        this.win = null;
      });
      this.onStateChange({ realtimeActive: true });
      this.schedule(60);
      this.notify('实时字幕已开启', `再次按 ${settings.hotkeys.realtime} 即可停止`);
    } catch (err) {
      this.notify('实时字幕启动失败', err.message);
    } finally {
      this.selecting = false;
    }
  }

  send(payload) {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send('realtime:update', payload);
    }
  }

  schedule(delay) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  async tick() {
    if (!this.active) return;
    try {
      if (this.busy) return;
      this.busy = true;
      const res = await this.ocr.recognizeRegion(this.physical, {
        imagePath: this.tmpImage,
        lang: this.ocrLang || 'auto',
      });
      if (!this.active) return;
      if (!this.ocrLang && res.engine) this.ocrLang = res.engine;
      const text = String(res.text || '').trim().slice(0, 1600);
      if (!text) {
        this.emptyStreak += 1;
        if (!this.lastText && this.emptyStreak === 1) {
          this.send({ status: 'waiting', original: '', translated: '' });
        }
        return;
      }
      this.emptyStreak = 0;
      const key = normalizeKey(text);
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.lastText = text;
      const settings = this.settings.get();
      const mode = settings.contentDomain || 'auto';
      const domain = mode === 'auto' ? detectDomain(text) : mode;
      const direction = resolveDirection(text, settings);
      const domainSuffix = domain !== 'general' ? ` · ${DOMAIN_LABELS[domain]}` : '';
      const directionLabel = `${this.langShort(direction.source)} → ${LANG_NAMES[direction.target] || direction.target}${domainSuffix}`;
      this.send({
        status: 'loading',
        original: text,
        translated: '',
        direction: directionLabel,
        domain,
      });
      await this.translate(text, direction, settings, directionLabel, domain);
    } catch (err) {
      if (!this.active) return;
      if (Date.now() - this.lastErrorAt > 4000) {
        this.lastErrorAt = Date.now();
        this.send({
          status: 'error',
          original: this.lastText || '',
          translated: '',
          message: err.message,
        });
      }
    } finally {
      this.busy = false;
      if (this.active) this.schedule(this.settings.get().realtime.intervalMs);
    }
  }

  langShort(lang) {
    return { 'zh-CN': '中文', en: 'EN', ja: '日本語', ko: '한국어', ru: 'RU' }[lang] || lang;
  }

  async translate(text, direction, settings, directionLabel, domain) {
    const cacheKey = `${text}\u0000${direction.target}\u0000${domain}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      this.send({
        status: 'done',
        original: text,
        translated: cached.text,
        direction: directionLabel,
        provider: cached.provider,
        domain,
      });
      return;
    }
    if (Date.now() - this.lastErrorAt < 8000) {
      this.send({
        status: 'error',
        original: text,
        translated: '',
        message: '翻译服务暂时不可用',
        direction: directionLabel,
        domain,
      });
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    let provider = this.engine === 'ai' ? providerLabel(settings.provider) : '免费翻译';
    try {
      let output = '';
      if (this.engine === 'ai' && this.settings.hasProvider()) {
        try {
          const result = await translateAI(text, direction.source, direction.target, {
            provider: settings.provider,
            signal: controller.signal,
            domain,
            realtime: true,
            onDelta: (delta) => {
              output += delta;
              this.send({
                status: 'streaming',
                original: text,
                translated: output,
                direction: directionLabel,
                provider: providerLabel(settings.provider),
                domain,
              });
            },
          });
          output = result.text;
        } catch (aiError) {
          if (controller.signal.aborted || !this.active) return;
          if (!settings.freeTranslation) throw aiError;
          const fallback = await translateFree(text, direction.source, direction.target, {
            signal: controller.signal,
          });
          output = fallback.text;
          this.engine = 'free';
          provider = '免费翻译';
          if (!this.aiFallbackNotified) {
            this.aiFallbackNotified = true;
            this.notify(
              '实时字幕已切换免费通道',
              `AI 翻译不可用：${String(aiError.message || '').slice(0, 120)}`,
            );
          }
        }
      } else {
        const result = await translateFree(text, direction.source, direction.target, {
          signal: controller.signal,
        });
        output = result.text;
        provider = result.provider;
      }
      if (!this.active) return;
      if (output) {
        this.remember(cacheKey, { text: output, provider });
        this.send({
          status: 'done',
          original: text,
          translated: output,
          direction: directionLabel,
          provider,
          domain,
        });
      }
    } catch (err) {
      if (controller.signal.aborted || !this.active) return;
      this.lastErrorAt = Date.now();
      this.send({
        status: 'error',
        original: text,
        translated: '',
        message: err.message,
        direction: directionLabel,
        domain,
      });
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  remember(key, value) {
    if (this.cache.size > 120) {
      const first = this.cache.keys().next().value;
      this.cache.delete(first);
    }
    this.cache.set(key, value);
  }

  stop({ silent = false } = {}) {
    if (!this.active && !this.win) return;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.abort) {
      try { this.abort.abort(); } catch {}
      this.abort = null;
    }
    if (this.win && !this.win.isDestroyed()) {
      try { this.win.destroy(); } catch {}
    }
    this.win = null;
    this.onStateChange({ realtimeActive: false });
  }
}

module.exports = { RealtimeController };
