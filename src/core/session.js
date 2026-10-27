const fs = require('fs');
const path = require('path');
const { nativeImage, screen } = require('electron');
const { selectRegion } = require('../windows/overlay');
const { cropDisplayImage } = require('./capture');
const {
  resolveDirection,
  translateFree,
  translateAI,
  LANG_NAMES,
} = require('./translate');
const { providerLabel, streamChat } = require('./llm');
const { detectDomain, normalizeDomain, DOMAIN_LABELS } = require('./domain');
const { buildExplainSystem } = require('./prompts');
const {
  extractKeywordsAI,
  extractRuleKeywords,
  buildSearchLinks,
  mergeKeywords,
} = require('./search');

const MAX_SOURCE = 6000;
const MAX_EXPLAIN_SOURCE = 6000;
const MAX_VISION_SIDE = 1600;

function newId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function truncate(text, max) {
  const value = String(text || '');
  return value.length > max ? `${value.slice(0, max)}\n…` : value;
}

function idleExplanation() {
  return {
    status: 'idle',
    text: '',
    provider: '',
    error: '',
    notice: '',
    message: '',
  };
}

function idleRelated() {
  return {
    status: 'idle',
    keywords: [],
    links: [],
    source: '',
    notice: '',
    error: '',
    topic: '',
  };
}

class SessionManager {
  constructor({ settings, ocr, history, resultWindow, tempDir, onHistoryChanged, onStateChange, notify, minimizeHome, restoreHome }) {
    this.settings = settings;
    this.ocr = ocr;
    this.history = history;
    this.result = resultWindow;
    this.tempDir = tempDir;
    this.onHistoryChanged = onHistoryChanged || (() => {});
    this.onStateChange = onStateChange || (() => {});
    this.notify = notify || (() => {});
    this.minimizeHome = minimizeHome || (async () => false);
    this.restoreHome = restoreHome || (() => {});
    this.homeMinimized = false;
    this.selecting = false;
    this.current = null;
    this.translateAbort = null;
    this.explainAbort = null;
    this.relatedAbort = null;
    this.relatedSeq = 0;
    fs.mkdirSync(tempDir, { recursive: true });
  }

  publicRecord(record) {
    const settings = this.settings.get();
    return {
      id: record.id,
      createdAt: record.createdAt,
      source: record.source || '',
      translation: { ...record.translation },
      explanation: { ...record.explanation },
      related: { ...(record.related || idleRelated()) },
      engine: record.engine,
      meta: {
        sourceLang: record.sourceLang,
        targetLang: record.targetLang,
        ocrEngine: record.ocrEngine,
        ocrMs: record.ocrMs,
        durationMs: record.durationMs,
        hasProvider: this.settings.hasProvider(),
        providerLabel: providerLabel(settings.provider),
        hasHistory: Boolean(record.historySaved),
        empty: record.empty || false,
        domain: record.domain,
        domainMode: record.domainMode,
        detectedDomain: record.detectedDomain,
        domainLabel: DOMAIN_LABELS[record.domain] || '',
        visionUsed: Boolean(record.visionUsed),
        visionEnabled: Boolean(settings.vision?.enabled),
        freeTranslation: settings.freeTranslation !== false,
      },
    };
  }

  update(record) {
    if (this.current && this.current.record.id === record.id) {
      this.result.update(this.publicRecord(record));
    }
  }

  abortStreams() {
    if (this.translateAbort) {
      try { this.translateAbort.abort(); } catch {}
      this.translateAbort = null;
    }
    if (this.explainAbort) {
      try { this.explainAbort.abort(); } catch {}
      this.explainAbort = null;
    }
    this.abortRelated();
  }

  abortRelated() {
    this.relatedSeq += 1;
    if (this.relatedAbort) {
      try { this.relatedAbort.abort(); } catch {}
      this.relatedAbort = null;
    }
  }

  applyDomain(record, settings) {
    const mode = normalizeDomain(record.domainMode || settings.contentDomain, 'auto');
    record.domainMode = mode;
    record.detectedDomain = detectDomain(record.source);
    record.domain = mode === 'auto' ? record.detectedDomain : mode;
  }

  async startSelection() {
    if (this.selecting) return;
    this.selecting = true;
    this.onStateChange({ selecting: true });
    let resultShown = false;
    try {
      const hadResult = this.result.isOpen();
      this.result.hide();
      this.homeMinimized = await this.minimizeHome();
      const selection = await selectRegion();
      if (!selection) {
        if (this.homeMinimized) {
          this.homeMinimized = false;
          this.restoreHome();
        }
        if (hadResult && this.current) {
          this.result.show(this.publicRecord(this.current.record), this.current.record.rect);
        }
        return;
      }
      this.abortStreams();
      const { rect, displayShot } = selection;
      const { image } = cropDisplayImage(displayShot, rect);
      const settings = this.settings.get();
      const record = {
        id: newId(),
        createdAt: Date.now(),
        source: '',
        sourceLang: 'auto',
        targetLang: settings.targetLang,
        translation: { status: 'ocr', text: '', provider: '', error: '', notice: '' },
        explanation: idleExplanation(),
        related: idleRelated(),
        engine: 'free',
        domain: 'general',
        domainMode: normalizeDomain(settings.contentDomain, 'auto'),
        detectedDomain: 'general',
        visionUsed: false,
        ocrEngine: '',
        ocrMs: 0,
        durationMs: 0,
        historySaved: false,
        rect,
        displayId: displayShot.display.id,
        image,
      };
      this.current = { record };
      this.result.show(this.publicRecord(record), rect);
      resultShown = true;
      const png = image.toPNG();
      const tempImage = path.join(this.tempDir, `${record.id}.png`);
      fs.writeFileSync(tempImage, png);
      this.runRecognition(record, png, tempImage).catch((err) => {
        if (!this.current || this.current.record.id !== record.id) return;
        record.translation = {
          status: 'error',
          text: '',
          provider: '',
          error: `处理失败：${err.message}`,
          notice: '',
        };
        this.update(record);
      });
    } catch (err) {
      if (this.homeMinimized && !resultShown) {
        this.homeMinimized = false;
        this.restoreHome();
      }
      this.notify('框选失败', err.message);
    } finally {
      this.selecting = false;
      this.onStateChange({ selecting: false });
    }
  }

  async runRecognition(record, pngBuffer, tempImage) {
    let ocr;
    try {
      ocr = await this.ocr.recognizeImage(tempImage, { lang: 'auto' });
    } catch (err) {
      record.translation = {
        status: 'error',
        text: '',
        provider: '',
        error: `文字识别失败：${err.message}`,
        notice: '',
      };
      this.update(record);
      return;
    }
    if (!this.current || this.current.record.id !== record.id) return;

    record.source = ocr.text || '';
    record.ocrEngine = ocr.engine;
    record.ocrMs = ocr.ocrMs;

    if (!record.source.trim() || !/[A-Za-z0-9\u3400-\u9fff]/.test(record.source)) {
      record.empty = true;
      record.translation = {
        status: 'empty',
        text: '',
        provider: '',
        error: '',
        notice: '',
      };
      record.explanation = idleExplanation();
      this.update(record);
      return;
    }

    const settings = this.settings.get();
    const direction = resolveDirection(record.source, settings);
    record.sourceLang = direction.source;
    record.targetLang = direction.target;
    record.engine = this.pickEngine();
    this.applyDomain(record, settings);

    record.translation = {
      status: 'loading',
      text: '',
      provider: record.engine === 'ai' ? providerLabel(settings.provider) : '免费翻译',
      error: '',
      notice: '',
    };
    this.update(record);

    this.saveToHistory(record, pngBuffer);
    await this.runTranslation(record);
  }

  saveToHistory(record, pngBuffer) {
    const settings = this.settings.get();
    if (settings.historyPaused) return;
    let thumbBuffer = null;
    try {
      const size = record.image.getSize();
      const width = Math.min(520, size.width);
      thumbBuffer = record.image.resize({ width, quality: 'good' }).toJPEG(78);
    } catch {}
    try {
      const { image, thumb } = this.history.saveImages(record.id, pngBuffer, thumbBuffer);
      record.imageName = image;
      record.thumbName = thumb;
      record.historySaved = true;
      this.history.add(this.historyRecord(record));
      this.onHistoryChanged();
    } catch {
      record.historySaved = false;
    }
  }

  historyRecord(record) {
    return {
      id: record.id,
      createdAt: record.createdAt,
      source: record.source,
      translation: record.translation.text || '',
      explanation: record.explanation.text || '',
      related: record.related || idleRelated(),
      sourceLang: record.sourceLang,
      targetLang: record.targetLang,
      engine: record.engine,
      domain: record.domain,
      domainMode: record.domainMode,
      detectedDomain: record.detectedDomain,
      visionUsed: Boolean(record.visionUsed),
      ocrEngine: record.ocrEngine,
      rect: record.rect,
      displayId: record.displayId,
      image: record.imageName || '',
      thumb: record.thumbName || '',
    };
  }

  persist(record) {
    if (!record.historySaved) return;
    this.history.update(record.id, this.historyRecord(record));
    this.onHistoryChanged();
  }

  imageForModel(record) {
    const settings = this.settings.get();
    if (!settings.vision?.enabled || !this.settings.hasProvider()) return '';
    if (!record.image || record.image.isEmpty()) return '';
    try {
      const size = record.image.getSize();
      const longest = Math.max(size.width, size.height);
      const scale = Math.min(1, MAX_VISION_SIDE / longest);
      const image = scale < 1
        ? record.image.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          quality: 'good',
        })
        : record.image;
      return `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`;
    } catch {
      return '';
    }
  }

  async streamAITranslation(record, source, target, { image, controller, settings, started }) {
    record.translation = {
      status: 'loading',
      text: '',
      provider: providerLabel(settings.provider),
      error: '',
      notice: record.translation.notice || '',
    };
    this.update(record);
    const result = await translateAI(source, record.sourceLang, target, {
      provider: settings.provider,
      signal: controller.signal,
      domain: record.domain,
      image,
      onDelta: (delta) => {
        if (!this.current || this.current.record.id !== record.id) return;
        record.translation.text += delta;
        this.result.delta('translation', delta);
      },
    });
    if (!result.text.trim()) throw new Error('模型没有返回译文');
    record.translation.text = result.text;
    record.translation.provider = result.provider;
    record.translation.status = 'done';
    record.durationMs = Date.now() - started;
    this.update(record);
    this.persist(record);
  }

  async freeTranslate(record, source, target, controller) {
    return translateFree(source, record.sourceLang, target, {
      signal: controller.signal,
      onPartial: (partial) => {
        if (!this.current || this.current.record.id !== record.id) return;
        if (controller.signal.aborted) return;
        record.translation.text = partial;
        record.translation.status = 'loading';
        this.update(record);
      },
    });
  }

  async runTranslation(record) {
    const settings = this.settings.get();
    this.applyDomain(record, settings);
    this.abortRelated();
    record.related = idleRelated();
    const source = truncate(record.source, MAX_SOURCE);
    const started = Date.now();
    const controller = new AbortController();
    this.translateAbort = controller;
    const target = record.targetLang;
    const engine = record.engine;
    record.visionUsed = false;

    record.translation = {
      status: 'loading',
      text: '',
      provider: engine === 'ai' ? providerLabel(settings.provider) : '免费翻译',
      error: '',
      notice: '',
    };
    this.update(record);

    try {
      if (engine !== 'ai') {
        if (!settings.freeTranslation) {
          record.translation = {
            status: 'error',
            text: '',
            provider: '',
            error: '免费翻译通道已关闭。请在设置中启用，或配置 AI 模型。',
            notice: '',
          };
          this.update(record);
          this.persist(record);
          return;
        }
        try {
          const result = await this.freeTranslate(record, source, target, controller);
          record.translation = {
            status: 'done',
            text: result.text,
            provider: result.provider,
            error: '',
            notice: '',
          };
          record.durationMs = Date.now() - started;
          this.update(record);
          this.persist(record);
        } catch (err) {
          if (controller.signal.aborted) return;
          record.translation = {
            status: 'error',
            text: '',
            provider: '免费翻译',
            error: `翻译失败：${err.message}`,
            notice: '',
          };
          this.update(record);
          this.persist(record);
        }
        return;
      }

      if (!this.settings.hasProvider()) {
        record.translation = {
          status: 'error',
          text: '',
          provider: '',
          error: '尚未配置 AI 模型，请在设置中接入模型，或启用免费翻译通道。',
          notice: '',
        };
        this.update(record);
        this.persist(record);
        return;
      }

      const image = this.imageForModel(record);
      if (image) record.visionUsed = true;
      let lastError = null;
      try {
        await this.streamAITranslation(record, source, target, {
          image,
          controller,
          settings,
          started,
        });
        return;
      } catch (err) {
        if (controller.signal.aborted) return;
        lastError = err;
      }

      if (image) {
        record.translation.notice = `读图模式不可用，已改用文本翻译：${lastError.message}`;
        try {
          await this.streamAITranslation(record, source, target, {
            image: '',
            controller,
            settings,
            started,
          });
          return;
        } catch (err) {
          if (controller.signal.aborted) return;
          lastError = err;
        }
      }

      if (settings.freeTranslation) {
        try {
          record.translation = {
            status: 'loading',
            text: '',
            provider: '免费翻译',
            error: '',
            notice: `AI 翻译不可用，已改用免费翻译：${lastError.message}`,
          };
          this.update(record);
          const fallback = await this.freeTranslate(record, source, target, controller);
          record.translation = {
            status: 'done',
            text: fallback.text,
            provider: fallback.provider,
            error: '',
            notice: `AI 翻译不可用，已改用免费翻译：${lastError.message}`,
          };
          record.durationMs = Date.now() - started;
          this.update(record);
          this.persist(record);
          return;
        } catch {}
      }

      record.translation = {
        status: 'error',
        text: '',
        provider: providerLabel(settings.provider),
        error: `翻译失败：${lastError.message}`,
        notice: '',
      };
      this.update(record);
      this.persist(record);
    } finally {
      if (this.translateAbort === controller) {
        this.translateAbort = null;
        if (record.translation.status === 'done') {
          this.generateRelated(record).catch(() => {});
        }
      }
    }
  }

  async retranslate({ engine } = {}) {
    const current = this.current;
    if (!current) return;
    const record = current.record;
    if (!record.source) {
      await this.startSelection();
      return;
    }
    this.abortStreams();
    record.explanation = idleExplanation();
    const settings = this.settings.get();
    const direction = resolveDirection(record.source, settings);
    record.sourceLang = direction.source;
    record.targetLang = direction.target;
    record.engine = engine === 'free' || engine === 'ai' ? engine : this.pickEngine();
    await this.runTranslation(record);
  }

  async setDomain(mode) {
    const current = this.current;
    if (!current) return;
    const value = normalizeDomain(mode, '');
    if (!value) return;
    const record = current.record;
    if (!record.source) return;
    this.abortStreams();
    record.domainMode = value;
    this.applyDomain(record, this.settings.get());
    record.explanation = idleExplanation();
    const settings = this.settings.get();
    const direction = resolveDirection(record.source, settings);
    record.sourceLang = direction.source;
    record.targetLang = direction.target;
    record.engine = this.pickEngine();
    await this.runTranslation(record);
  }

  pickEngine() {
    const settings = this.settings.get();
    if ((settings.translateEngine || 'auto') === 'free') return 'free';
    return this.settings.hasProvider() ? 'ai' : 'free';
  }

  refreshCurrent() {
    if (this.current) this.update(this.current.record);
  }

  async generateRelated(record, { allowAI = true } = {}) {
    if (!record || !this.current || this.current.record.id !== record.id) return;
    if (!record.source || record.translation?.status !== 'done') return;
    this.abortRelated();
    const seq = this.relatedSeq;
    const controller = new AbortController();
    this.relatedAbort = controller;
    record.related = {
      status: 'loading',
      keywords: [],
      links: [],
      source: '',
      notice: '',
      error: '',
      topic: '',
    };
    this.update(record);

    let rule = { keywords: [], topic: '' };
    try {
      rule = extractRuleKeywords({
        source: record.source,
        translation: record.translation.text || '',
        domain: record.domain,
        sourceLang: record.sourceLang,
        targetLang: record.targetLang,
      });
    } catch {}

    let aiKeywords = [];
    let notice = '';
    const settings = this.settings.get();
    const useAI = allowAI
      && record.engine === 'ai'
      && record.translation.provider !== '免费翻译'
      && this.settings.hasProvider();
    if (useAI) {
      try {
        aiKeywords = await extractKeywordsAI({
          provider: settings.provider,
          source: record.source,
          translation: record.translation.text || '',
          domain: record.domain,
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        notice = 'AI 关键词不可用，已使用本地提取';
      }
    }

    if (controller.signal.aborted || seq !== this.relatedSeq) return;
    if (!this.current || this.current.record.id !== record.id) return;
    let keywords;
    if (aiKeywords.length >= 3) {
      keywords = mergeKeywords(aiKeywords, []);
    } else if (aiKeywords.length) {
      keywords = mergeKeywords(aiKeywords, rule.keywords);
    } else {
      keywords = rule.keywords;
    }
    const links = buildSearchLinks({
      keywords,
      domain: record.domain,
      topic: rule.topic,
      sourceLang: record.sourceLang,
      targetLang: record.targetLang,
    });
    record.related = {
      status: 'done',
      keywords,
      links,
      source: aiKeywords.length ? 'ai' : 'rules',
      notice,
      error: '',
      topic: rule.topic,
    };
    if (this.relatedAbort === controller) this.relatedAbort = null;
    this.update(record);
    this.persist(record);
  }

  async ensureRelated({ force = false } = {}) {
    const current = this.current;
    if (!current) return;
    const record = current.record;
    if (!record.source || record.translation?.status !== 'done') return;
    if (!force && ['loading', 'done'].includes(record.related?.status)) return;
    await this.generateRelated(record, { allowAI: true });
  }

  async streamAIExplanation(record, { image, controller, settings }) {
    const language = LANG_NAMES[settings.explanationLanguage] || '简体中文';
    const system = buildExplainSystem(language, record.domain, {
      vision: Boolean(image),
    });
    const userText = `屏幕内容（OCR 结果，可能有识别误差）：\n<<<\n${truncate(record.source, MAX_EXPLAIN_SOURCE)}\n>>>\n\n屏幕翻译（供参考）：\n<<<\n${truncate(record.translation.text, 3000) || '（暂无）'}\n>>>`;
    const userContent = image
      ? [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: image } },
      ]
      : userText;
    record.explanation = {
      status: 'loading',
      text: '',
      provider: providerLabel(settings.provider),
      error: '',
      notice: record.explanation.notice || '',
      message: '',
    };
    this.update(record);
    const text = await streamChat({
      provider: settings.provider,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature: 0.5,
      maxTokens: 1100,
      signal: controller.signal,
      onDelta: (delta) => {
        if (!this.current || this.current.record.id !== record.id) return;
        record.explanation.text += delta;
        this.result.delta('explanation', delta);
      },
    });
    if (!text.trim()) throw new Error('模型没有返回解释内容');
    record.explanation.text = text;
    record.explanation.status = 'done';
    this.update(record);
    this.persist(record);
  }

  async explain({ force = false } = {}) {
    const current = this.current;
    if (!current) return;
    const record = current.record;
    if (!record.source) return;
    if (!force && ['done', 'loading'].includes(record.explanation.status)) return;

    if (this.explainAbort) {
      try { this.explainAbort.abort(); } catch {}
      this.explainAbort = null;
    }
    const settings = this.settings.get();

    if (!this.settings.hasProvider()) {
      record.explanation = {
        status: 'unavailable',
        text: '',
        provider: '',
        error: '',
        notice: '',
        message: '解释由 AI 生成。请先在设置中接入 DeepSeek、通义千问等模型，或使用本地 Ollama。',
      };
      this.update(record);
      return;
    }

    const controller = new AbortController();
    this.explainAbort = controller;
    record.explanation = {
      status: 'loading',
      text: '',
      provider: providerLabel(settings.provider),
      error: '',
      notice: '',
      message: '',
    };
    this.update(record);

    const image = this.imageForModel(record);
    if (image) record.visionUsed = true;

    try {
      await this.streamAIExplanation(record, { image, controller, settings });
    } catch (err) {
      if (controller.signal.aborted) return;
      if (image) {
        record.explanation.notice = `读图模式不可用，已改用文本解释：${err.message}`;
        try {
          await this.streamAIExplanation(record, { image: '', controller, settings });
          return;
        } catch (err2) {
          if (controller.signal.aborted) return;
          record.explanation.status = 'error';
          record.explanation.error = `解释失败：${err2.message}`;
          this.update(record);
          return;
        }
      }
      record.explanation.status = 'error';
      record.explanation.error = `解释失败：${err.message}`;
      this.update(record);
    } finally {
      if (this.explainAbort === controller) this.explainAbort = null;
    }
  }

  openHistory(id) {
    const item = this.history.get(id);
    if (!item) return;
    this.abortStreams();
    const settings = this.settings.get();
    const record = {
      id: item.id,
      createdAt: item.createdAt,
      source: item.source || '',
      sourceLang: item.sourceLang || 'auto',
      targetLang: item.targetLang || settings.targetLang,
      translation: {
        status: item.translation ? 'done' : 'idle',
        text: item.translation || '',
        provider: item.engine === 'ai' ? 'AI 模型' : '免费翻译',
        error: '',
        notice: '',
      },
      explanation: {
        status: item.explanation ? 'done' : 'idle',
        text: item.explanation || '',
        provider: item.engine === 'ai' ? 'AI 模型' : '',
        error: '',
        notice: '',
        message: '',
      },
      related: item.related || idleRelated(),
      engine: item.engine || 'free',
      domain: item.domain || 'general',
      domainMode: normalizeDomain(item.domainMode || settings.contentDomain, 'auto'),
      detectedDomain: item.detectedDomain || detectDomain(item.source || ''),
      visionUsed: Boolean(item.visionUsed),
      ocrEngine: item.ocrEngine || '',
      ocrMs: 0,
      durationMs: 0,
      historySaved: true,
      rect: item.rect || {
        x: screen.getPrimaryDisplay().workArea.x + 200,
        y: screen.getPrimaryDisplay().workArea.y + 200,
        width: 0,
        height: 0,
      },
      displayId: item.displayId,
      image: null,
    };
    try {
      if (item.image) {
        const file = path.join(this.history.imagesDir, item.image);
        if (fs.existsSync(file)) record.image = nativeImage.createFromPath(file);
      }
    } catch {}
    if (!item.domain) this.applyDomain(record, settings);
    this.current = { record };
    this.result.show(this.publicRecord(record), record.rect);
    if (!item.related && record.source && record.translation.text) {
      this.generateRelated(record, { allowAI: false }).catch(() => {});
    }
  }

  restoreResult() {
    if (this.current) {
      this.result.show(this.publicRecord(this.current.record), this.current.record.rect);
    }
  }

  closeResult() {
    this.result.close();
    this.abortStreams();
    this.current = null;
    if (this.homeMinimized) {
      this.homeMinimized = false;
      this.restoreHome();
    }
  }
}

module.exports = { SessionManager };
