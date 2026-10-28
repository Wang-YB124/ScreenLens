const path = require('path');
const { captureDisplaysFast, dipToPhysicalRect } = require('./capture');
const { selectRegion, cancelSelection } = require('../windows/overlay');
const { createRealtimeWindow, sendRealtimeInit } = require('../windows/realtimeWindow');
const { resolveRealtimeDirection, translateFree, translateAI, LANG_NAMES } = require('./translate');
const { providerLabel } = require('./llm');
const { detectDomain, DOMAIN_LABELS } = require('./domain');
const { startTiming, markTiming, finishTiming, waitHideSettle, HIDE_SETTLE_MS } = require('./timing');

function normalizeKey(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1600);
}

function tailLines(text, maxLines = 8, maxChars = 800) {
  const value = String(text || '').trim();
  if (!value) return '';
  const lines = value.replace(/\r/g, '').split('\n');
  let out = lines.slice(-maxLines).join('\n').trim();
  if (out.length > maxChars) out = out.slice(-maxChars).trim();
  return out;
}

class RealtimeController {
  constructor({ settings, ocr, tempDir, onStateChange, notify, hideResult, restoreResult, minimizeHome, restoreHome }) {
    this.settings = settings;
    this.ocr = ocr;
    this.tempDir = tempDir;
    this.hideResult = hideResult || (() => false);
    this.restoreResult = restoreResult || (() => {});
    this.minimizeHome = minimizeHome || (async () => false);
    this.restoreHome = restoreHome || (() => {});
    this.homeMinimized = false;
    this.onStateChange = onStateChange || (() => {});
    this.notify = notify || (() => {});
    this.active = false;
    this.selecting = false;
    this.busy = false;
    this.startCount = 0;
    this.timingId = '';
    this.timedFirstOcrStart = false;
    this.timedFirstOcrDone = false;
    this.timedFirstTranslate = false;
    this.firstOriginalSent = false;
    this.firstSubtitleSent = false;
    this.timer = null;
    this.win = null;
    this.abort = null;
    this.cache = new Map();
    this.lastKey = '';
    this.lastErrorAt = 0;
    this.lastWindowErrorAt = 0;
    this.targetWindow = null;
    this.windowGoneCount = 0;
    this.tmpImage = path.join(tempDir, 'realtime.png');
  }

  isActive() {
    return this.active;
  }

  async start(options = {}) {
    if (this.active || this.selecting) return;
    this.cancelRequested = false;
    this.selecting = true;
    this.onStateChange({ selecting: true });
    const timingId = startTiming('realtime', {
      source: options.source || 'unknown',
      clickedAt: options.clickedAt,
      round: ++this.startCount,
    });
    this.timingId = timingId;
    this.timedFirstOcrStart = false;
    this.timedFirstOcrDone = false;
    this.timedFirstTranslate = false;
    this.firstOriginalSent = false;
    this.firstSubtitleSent = false;
    try {
      if (!this.ocr.available) {
        markTiming(timingId, 'ocr-unavailable');
        this.notify('实时字幕无法启动', 'OCR 引擎暂不可用，请稍后重试');
        finishTiming(timingId, { outcome: 'ocr-unavailable' });
        return;
      }
      const hadResult = this.hideResult();
      markTiming(timingId, 'result-hidden', { hadResult });
      this.homeMinimized = await this.minimizeHome();
      markTiming(timingId, 'home-hidden', { hidden: this.homeMinimized });
      if (this.homeMinimized || hadResult) {
        await waitHideSettle();
        markTiming(timingId, 'hide-settled', { ms: HIDE_SETTLE_MS, home: this.homeMinimized, result: hadResult });
      }
      if (this.cancelRequested) {
        this.cancelRequested = false;
        this.releaseHome();
        finishTiming(timingId, { outcome: 'cancelled' });
        return;
      }
      const selection = await selectRegion({
        timingId,
        finishOnFrame: false,
        capture: (opts) => captureDisplaysFast(this.ocr, this.tempDir, opts),
        windowsProvider: () => this.ocr.listWindows({ excludePid: process.pid }),
      });
      markTiming(timingId, 'selection-result', { hasSelection: Boolean(selection) });
      if (this.cancelRequested) {
        this.cancelRequested = false;
        this.releaseHome();
        finishTiming(timingId, { outcome: 'cancelled' });
        return;
      }
      if (!selection) {
        this.releaseHome();
        if (hadResult) this.restoreResult();
        finishTiming(timingId, { outcome: 'cancel' });
        return;
      }
      if (this.active) {
        this.releaseHome();
        finishTiming(timingId, { outcome: 'race-active' });
        return;
      }
      const settings = this.settings.get();
      const canAI = this.settings.hasProvider();
      this.engine = settings.realtime.engine === 'free'
        ? 'free'
        : (canAI ? 'ai' : 'free');
      if (this.engine === 'free' && !settings.freeTranslation) {
        markTiming(timingId, 'engine-unavailable');
        this.releaseHome();
        this.notify('实时字幕无法启动', '请先在设置中配置 AI 模型，或开启免费翻译通道。');
        finishTiming(timingId, { outcome: 'engine-unavailable' });
        return;
      }
      this.selection = selection;
      this.physical = dipToPhysicalRect(selection.rect);
      this.targetWindow = selection.window || null;
      this.windowGoneCount = 0;
      this.lastWindowErrorAt = 0;
      this.ocrLang = null;
      this.lastKey = '';
      this.lastText = '';
      this.emptyStreak = 0;
      this.aiFallbackNotified = false;
      this.cache.clear();
      this.active = true;
      this.win = createRealtimeWindow({
        rect: selection.rect,
        settings,
        windowTitle: this.targetWindow ? this.targetWindow.title : '',
      });
      this.win.on('closed', () => {
        this.win = null;
      });
      markTiming(timingId, 'subtitle-window-created');
      this.onStateChange({ realtimeActive: true });
      this.schedule(60);
      const windowNote = this.targetWindow
        ? `正在识别窗口「${String(this.targetWindow.title || '').slice(0, 32)}」；`
        : '';
      if (this.engine === 'free') {
        this.notify('实时字幕已开启（免费翻译）', `${windowNote}免费通道约 1 秒/句，配置 AI 模型后字幕会更流畅；再次按 ${settings.hotkeys.realtime} 停止`);
      } else {
        this.notify('实时字幕已开启', `${windowNote}再次按 ${settings.hotkeys.realtime} 即可停止`);
      }
    } catch (err) {
      markTiming(timingId, 'error', { message: String(err.message || '').slice(0, 160) });
      this.releaseHome();
      this.notify('实时字幕启动失败', err.message);
      finishTiming(timingId, { outcome: 'error' });
    } finally {
      this.selecting = false;
      this.onStateChange({ selecting: false });
    }
  }

  send(payload) {
    if (!this.firstOriginalSent && payload?.original) {
      this.firstOriginalSent = true;
      markTiming(this.timingId, 'first-original', { chars: String(payload.original).length });
    }
    if (!this.firstSubtitleSent && payload?.translated) {
      this.firstSubtitleSent = true;
      markTiming(this.timingId, 'first-subtitle', { chars: String(payload.translated).length });
      finishTiming(this.timingId, { outcome: 'first-subtitle' });
    }
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
      if (!this.timedFirstOcrStart) {
        this.timedFirstOcrStart = true;
        markTiming(this.timingId, 'first-ocr-start');
      }
      let res;
      try {
        res = this.targetWindow
          ? await this.ocr.recognizeWindow(this.targetWindow.id, {
            imagePath: this.tmpImage,
            lang: this.ocrLang || 'auto',
          })
          : await this.ocr.recognizeRegion(this.physical, {
            imagePath: this.tmpImage,
            lang: this.ocrLang || 'auto',
          });
      } catch (err) {
        if (!this.active) return;
        const issue = this.windowIssue(err.message);
        if (issue) {
          if (String(err.message || '').includes('WINDOW_GONE')) {
            this.windowGoneCount += 1;
            if (this.windowGoneCount >= 8) {
              this.stop({ silent: true });
              this.notify('实时字幕已停止', '目标窗口已关闭');
              return;
            }
          }
          if (Date.now() - this.lastWindowErrorAt > 3500) {
            this.lastWindowErrorAt = Date.now();
            this.send({
              status: 'error',
              original: this.lastText || '',
              translated: '',
              message: issue,
            });
          }
          return;
        }
        if (Date.now() - this.lastErrorAt > 4000) {
          this.lastErrorAt = Date.now();
          this.send({
            status: 'error',
            original: this.lastText || '',
            translated: '',
            message: '屏幕识别暂时不可用，正在重试…',
          });
        }
        return;
      }
      if (!this.active) return;
      this.windowGoneCount = 0;
      this.lastWindowErrorAt = 0;
      if (res.windowRect) this.physical = res.windowRect;
      if (!this.ocrLang && res.engine) this.ocrLang = res.engine;
      if (!this.timedFirstOcrDone) {
        this.timedFirstOcrDone = true;
        markTiming(this.timingId, 'first-ocr-done', { engine: res.engine, captureMs: res.captureMs });
      }
      const text = tailLines(String(res.text || '').trim().slice(0, 1600), 8, 800);
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
      const direction = resolveRealtimeDirection(text, settings);
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
          message: '字幕暂时不可用，正在重试…',
        });
      }
    } finally {
      this.busy = false;
      if (this.active) this.schedule(this.settings.get().realtime.intervalMs);
    }
  }

  windowIssue(message) {
    if (!this.targetWindow) return '';
    const value = String(message || '');
    if (value.includes('WINDOW_GONE')) return '目标窗口已关闭';
    if (value.includes('WINDOW_MINIMIZED')) return '目标窗口已最小化，恢复后自动继续';
    if (value.includes('WINDOW_TOO_SMALL')) return '目标窗口太小，无法识别';
    return '';
  }

  langShort(lang) {
    return {
      'zh-CN': '中文',
      en: 'EN',
      ja: '日本語',
      ko: '한국어',
      ru: 'RU',
      fr: 'FR',
      de: 'DE',
      es: 'ES',
      pt: 'PT',
      it: 'IT',
    }[lang] || lang;
  }

  invalidate() {
    this.lastKey = '';
    if (this.abort) {
      try { this.abort.abort(); } catch {}
      this.abort = null;
    }
  }

  refreshSettings() {
    sendRealtimeInit(this.win, this.settings.get());
  }

  async translate(text, direction, settings, directionLabel, domain) {
    const cacheKey = `${text}\u0000${direction.source}\u0000${direction.target}\u0000${domain}`;
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
        message: this.engine === 'free'
          ? '免费翻译暂时不可用，请稍后重试或配置 AI 模型'
          : 'AI 服务暂时不可用，请检查模型配置',
        direction: directionLabel,
        domain,
      });
      return;
    }
    const controller = new AbortController();
    this.abort = controller;
    if (!this.timedFirstTranslate) {
      this.timedFirstTranslate = true;
      markTiming(this.timingId, 'first-translate-start');
    }
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

  releaseHome() {
    if (!this.homeMinimized) return;
    this.homeMinimized = false;
    this.restoreHome();
  }

  stop({ silent = false } = {}) {
    if (this.selecting) {
      this.cancelRequested = true;
      cancelSelection();
      this.releaseHome();
      this.onStateChange({ realtimeActive: false });
      return;
    }
    if (!this.active && !this.win) {
      this.releaseHome();
      return;
    }
    if (!this.firstSubtitleSent) {
      markTiming(this.timingId, 'stop-before-subtitle');
      finishTiming(this.timingId, { outcome: 'stopped' });
    }
    this.active = false;
    this.targetWindow = null;
    this.windowGoneCount = 0;
    this.lastWindowErrorAt = 0;
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
    this.releaseHome();
    this.onStateChange({ realtimeActive: false });
  }
}

module.exports = { RealtimeController };
