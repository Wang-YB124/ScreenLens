const { chat } = require('./llm');

const DOMAIN_LABELS = {
  general: '通用',
  code: '代码',
  math: '数学',
  science: '科普',
};

const KEYWORD_SYSTEM = `You are ScreenLens's search-keyword extractor. Given a screen excerpt and its translation, return 3 to 5 concise search keywords or key phrases. Prefer proper nouns, product names, paper titles, technical terms and domain concepts. Avoid generic words, verbs and full sentences. Keep keywords in the source language unless a proper name is natively written in another language. Return ONLY a JSON array of strings, for example ["Albert Einstein", "theory of relativity"]. Do not return markdown, URLs or explanations.`;

const SITE_DEFS = {
  wikipedia: {
    site: '维基百科',
    description: '百科条目与背景',
    host: (lang) => (lang === 'zh' ? 'zh.wikipedia.org' : 'en.wikipedia.org'),
    url: (query, lang) => `https://${lang === 'zh' ? 'zh' : 'en'}.wikipedia.org/w/index.php?search=${encodeURIComponent(query)}`,
  },
  bing: {
    site: '必应',
    description: '网页搜索',
    host: 'www.bing.com',
    url: (query) => `https://www.bing.com/search?q=${encodeURIComponent(query)}`,
  },
  baidu: {
    site: '百度',
    description: '中文网页搜索',
    host: 'www.baidu.com',
    url: (query) => `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`,
  },
  scholar: {
    site: 'Google Scholar',
    description: '学术论文与引用',
    host: 'scholar.google.com',
    url: (query) => `https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`,
  },
  stackoverflow: {
    site: 'Stack Overflow',
    description: '代码问答',
    host: 'stackoverflow.com',
    url: (query) => `https://stackoverflow.com/search?q=${encodeURIComponent(query)}`,
  },
  github: {
    site: 'GitHub',
    description: '仓库与代码搜索',
    host: 'github.com',
    url: (query) => `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`,
  },
  pubmed: {
    site: 'PubMed',
    description: '医学文献',
    host: 'pubmed.ncbi.nlm.nih.gov',
    url: (query) => `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(query)}`,
  },
  bingnews: {
    site: 'Bing 新闻',
    description: '近期新闻报道',
    host: 'www.bing.com',
    url: (query) => `https://www.bing.com/news/search?q=${encodeURIComponent(query)}`,
  },
  wolfram: {
    site: 'Wolfram Alpha',
    description: '计算与公式',
    host: 'www.wolframalpha.com',
    url: (query) => `https://www.wolframalpha.com/input?i=${encodeURIComponent(query)}`,
  },
};

const GENERAL_TERMS = [
  'live captions', 'screen translation', 'real-time translation', 'machine translation',
  'screen translator', 'technical terms', 'ocr', 'subtitles', 'accessibility', 'layout', 'idioms',
  'reasoning', 'latency',
  '实时字幕', '屏幕翻译', '自动刷新', '翻译结果', '屏幕文字', '内容变化', '字幕', '翻译', '屏幕', '文字识别',
];

const DOMAIN_TERMS = {
  math: [
    'derivative', 'integral', 'definite integral', 'calculus', 'geometry', 'circle', 'sphere',
    'radius', 'diameter', 'area', 'volume', 'theorem', 'probability', 'matrix', 'vector',
    'equation', 'limit', '导数', '积分', '定积分', '微积分', '几何', '圆', '球', '半径',
    '直径', '面积', '体积', '定理', '概率', '矩阵', '向量', '方程', '极限',
  ],
  science: [
    'photosynthesis', 'chloroplast', 'chloroplasts', 'oxygen', 'glucose', 'protein', 'enzyme',
    'DNA', 'RNA', 'quantum', 'relativity', 'theory of relativity', 'gravity', 'newton',
    "newton's second law", 'force', 'mass', 'acceleration', 'velocity', 'momentum', 'energy',
    'physics', 'chemistry', 'biology', 'neuron', 'climate', '光合作用', '叶绿体', '氧气',
    '葡萄糖', '细胞', '蛋白质', '酶', '量子', '相对论', '引力', '牛顿', '牛顿第二定律',
    '质量', '加速度', '速度', '动量', '能量', '物理', '化学', '生物', '神经元', '气候',
  ],
  code: [
    'python', 'javascript', 'typescript', 'java', 'c++', 'c#', 'rust', 'golang',
    'function', 'array', 'object', 'generator', 'reduce', 'recursion', 'api',
  ],
};

const TOPIC_TERMS = {
  medical: [
    'medical law', 'medical', 'medicine', 'clinical', 'patient', 'patients', 'treatment',
    'diagnosis', 'disease', 'drug', 'therapy', 'symptom', 'hospital', 'informed consent',
    'consent', 'hypertension', 'blood pressure', 'heart disease', 'stroke', 'risks',
    '医学', '医疗', '医疗法', '患者', '治疗', '诊断', '药物',
    '临床', '症状', '血压', '疾病', '知情同意', '风险', '益处', '替代方案',
  ],
  legal: [
    'law', 'legal', 'court', 'contract', 'statute', 'consent', 'regulation', 'liability',
    'rights', 'tribunal', 'plaintiff', 'defendant', '法律', '法规', '法院', '合同',
    '诉讼', '条款', '权利', '责任',
  ],
  news: [
    'breaking news', 'news', 'press release', '新闻', '报道',
  ],
  product: [
    'battery life', 'product', 'price', 'specifications', 'specs', 'edition', '产品',
    '价格', '售价', '参数', '电池续航', '电池', '重量', '型号',
  ],
  history: [
    'history', 'historical', 'historian', 'born', 'century', 'nobel prize',
    'nobel prize in physics', 'theory of relativity', 'relativity', 'physicist',
    'philosopher', 'empire', 'revolution', 'war', '历史', '人物', '生于', '世纪',
    '诺贝尔奖', '相对论', '物理学家', '哲学家', '帝国', '革命', '战争',
  ],
};

const EN_STOP = new Set(`
  a an the and or but if then than so such of to in on at for from with without by as
  is are was were be been being am do does did this that these those it its their his her
  they he she we you i not no can could should would may might will just also more most
  very much many some any each other into over under about after before between during
  while where when who whom whose which what how why there here all both either neither
  only own same too s t don now up down out off again further once
  monday tuesday wednesday thursday friday saturday sunday january february march april
  may june july august september october november december good
`.trim().split(/\s+/));

const VERB_STOP = new Set(`
  keep keeps kept preserve preserves preserved explain explains explained translate translates
  translated translating convert converts converted release releases released capture captures
  captured refresh refreshes refreshed announce announced announces improve improves improved
  reduce reduces reduced weigh weighs weighed offer offers offered start starts started
  develop develops developed developing receive receives received received know knows knew known
  require requires required understand understands understood sign signs signed signing say says
  said saying report reports reported include includes included increase increases increased
  cause causes caused treat treats treated diagnose diagnoses diagnosed prevent prevents prevented
  change changes changed use uses used using make makes made making provide provides provided
  show shows showed shown lead leads led help helps helped allow allows allowed remain remains
  remained become becomes became appear appears appeared consider considers considered
  convert converts converting release releases releasing capture captures capturing reducing
`.trim().split(/\s+/));

const CODE_STOP = new Set(`
  def return function class const let var import from export default new async await if else
  elif for while in of is not and or try catch finally true false none null self this print
  console log length keep only positive values array string number boolean object json
`.trim().split(/\s+/));

const ALLOWED_HOSTS = new Set([
  'en.wikipedia.org',
  'zh.wikipedia.org',
  'www.bing.com',
  'www.baidu.com',
  'scholar.google.com',
  'stackoverflow.com',
  'github.com',
  'pubmed.ncbi.nlm.nih.gov',
  'www.wolframalpha.com',
]);

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanKeyword(value) {
  let text = String(value ?? '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '');
  text = text.replace(/^[\s,，、;；:：\-–—]+|[\s,，、;；:：\-–—]+$/g, '').trim();
  if (text.length < 2 || text.length > 60) return '';
  if (/^(?:https?:\/\/|www\.)/i.test(text)) return '';
  if (!/[A-Za-z0-9\u3400-\u9fff\u3040-\u30ff\uac00-\ud7afπ∑∫√∞]/.test(text)) return '';
  return text;
}

function matchTerm(text, term) {
  const value = String(text || '');
  const needle = String(term || '');
  if (!needle) return '';
  if (/^[\x00-\x7F]+$/.test(needle)) {
    const pattern = escapeRegExp(needle).replace(/\s+/g, '\\s+');
    const match = value.match(new RegExp(`(^|[^A-Za-z0-9])(${pattern})(?=[^A-Za-z0-9]|$)`, 'i'));
    return match ? match[2] : '';
  }
  return value.includes(needle) ? needle : '';
}

function detectTopic({ source, translation, domain }) {
  if (domain === 'code') return '';
  const text = `${source || ''}\n${translation || ''}`;
  if (/\b(?:medical|medicine|clinical|patient|patients|treatment|diagnosis|disease|drug|therapy|symptom|hospital|informed consent|hypertension|blood pressure)\b|医学|医疗|患者|治疗|诊断|药物|临床|症状|血压|疾病|知情同意/i.test(text)) {
    return 'medical';
  }
  const legalPattern = domain === 'science' || domain === 'math'
    ? /\b(?:legal|court|contract|statute|plaintiff|defendant|liability|tribunal|regulation)\b|法律|法规|法院|合同|诉讼|条款|责任/i
    : /\b(?:law|legal|court|contract|statute|plaintiff|defendant|liability|tribunal|regulation)\b|法律|法规|法院|合同|诉讼|条款|责任/i;
  if (legalPattern.test(text)) {
    return 'legal';
  }
  if (/\b(?:was a|was an|born|historian|century|nobel prize|theory of relativity|physicist|philosopher|empire|revolution)\b|历史|人物|生于|世纪|诺贝尔奖|相对论|物理学家|哲学家|帝国|革命/i.test(text)) {
    return 'history';
  }
  if (/\b(?:announced|reported|breaking news|press release|on (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|said)\b|新闻|报道|宣布|发布|消息/i.test(text)) {
    return 'news';
  }
  if (/\b(?:product|price|starts at|battery life|weighs|specifications|specs|edition)\b|产品|价格|售价|参数|电池续航|重量|型号/i.test(text)) {
    return 'product';
  }
  return '';
}

function detectCodeLanguage(text) {
  const value = String(text || '');
  if (/\bdef\s+[A-Za-z_]\w*\s*\(/.test(value)) return 'Python';
  if (/\bfunction\b|=>|\bconst\b|\blet\b|console\.log/.test(value)) return 'JavaScript';
  if (/\binterface\s+\w+|:\s*(?:string|number|boolean)\b/.test(value)) return 'TypeScript';
  if (/\bpublic\s+(?:class|static)\b|System\.out/.test(value)) return 'Java';
  if (/#include|std::|cout\s*<</.test(value)) return 'C++';
  if (/\busing\s+System\b|Console\.Write/.test(value)) return 'C#';
  if (/\bfunc\s+\w+\(|package\s+main/.test(value)) return 'Go';
  if (/\bfn\s+\w+\(|let\s+mut\b/.test(value)) return 'Rust';
  if (/\bSELECT\b[\s\S]+\bFROM\b/i.test(value)) return 'SQL';
  return '';
}

function pushCandidate(list, value, weight, origin, kind) {
  const text = cleanKeyword(value);
  if (!text) return;
  list.push({ value: text, weight, origin, kind });
}

function addProperCandidates(list, text, origin, knownTerms) {
  const re = /\b(?:[A-Z][A-Za-z0-9&'’.-]*|[A-Z]{2,}|[A-Za-z]+[0-9]+)(?:\s+(?:[A-Z0-9][A-Za-z0-9&'’.-]*|[A-Z]{2,})){0,3}\b/g;
  for (const match of String(text || '').matchAll(re)) {
    const raw = match[0].trim();
    const words = raw.split(/\s+/);
    const first = words[0].toLowerCase();
    if (EN_STOP.has(first)) continue;
    const single = words.length === 1;
    const internalCaps = /[A-Z].*[A-Z]/.test(raw);
    const hasDigit = /\d/.test(raw);
    if (single && EN_STOP.has(first.replace(/['’]s$/, ''))) continue;
    if (single) {
      const base = first.replace(/['’]s$/, '');
      if (hasDigit && (/^[a-z]/.test(raw) || raw.length < 3)) continue;
      if (!knownTerms.has(base) && !internalCaps && !hasDigit) continue;
    }
    const weight = (single ? (internalCaps || hasDigit ? 4.8 : 4.5) : 4.9) + (origin === 'source' ? 0 : -1.1);
    pushCandidate(list, raw, weight, origin, 'proper');
  }
}

function addTermCandidates(list, text, origin, domain, topic) {
  const sets = [
    DOMAIN_TERMS[domain] || [],
    TOPIC_TERMS[topic] || [],
    GENERAL_TERMS,
  ];
  for (const terms of sets) {
    for (const term of terms) {
      const matched = matchTerm(text, term);
      if (!matched) continue;
      const display = /^[\x00-\x7F]+$/.test(term) ? matched : term;
      const weight = 4.55 + (origin === 'source' ? 0.1 : -1.0) + (term.includes(' ') ? 0.15 : 0);
      pushCandidate(list, display, weight, origin, 'term');
    }
  }
}

function addContentCandidates(list, text) {
  const tokens = (String(text || '').match(/[A-Za-z][A-Za-z'-]{2,}/g) || [])
    .map((word) => word.toLowerCase());
  const content = tokens.filter((word) => !EN_STOP.has(word) && !VERB_STOP.has(word));
  const counts = new Map();
  for (const word of content) counts.set(word, (counts.get(word) || 0) + 1);
  const singles = [...counts.entries()]
    .filter(([word]) => word.length >= 4 && !CODE_STOP.has(word))
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .slice(0, 5);
  for (const [word] of singles) pushCandidate(list, word, 2.35, 'content', 'word');

  const bigrams = new Map();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const left = tokens[i];
    const right = tokens[i + 1];
    if (!content.includes(left) || !content.includes(right)) continue;
    const phrase = `${left} ${right}`;
    bigrams.set(phrase, (bigrams.get(phrase) || 0) + 1);
  }
  const topBigrams = [...bigrams.entries()]
    .filter(([phrase]) => phrase.length >= 8)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .slice(0, 4);
  for (const [phrase] of topBigrams) pushCandidate(list, phrase, 3.0, 'content', 'phrase');
}

function addCodeCandidates(list, source, translation) {
  const text = `${source || ''}\n${translation || ''}`;
  const lang = detectCodeLanguage(text);
  if (lang) pushCandidate(list, lang, 5.0, 'source', 'code');
  const ids = new Map();
  const sourceText = String(source || '');
  const allIds = `${sourceText}\n${translation || ''}`.match(/\b[A-Za-z_$][\w$]{2,}\b/g) || [];
  const functionName = (sourceText.match(/(?:function|def)\s+([A-Za-z_$][\w$]*)\s*\(/) || [])[1] || '';
  for (const raw of allIds) {
    const id = raw.toLowerCase();
    if (CODE_STOP.has(id) || EN_STOP.has(id) || VERB_STOP.has(id)) continue;
    if (id.length > 24) continue;
    const entry = ids.get(id) || { count: 0, name: raw, boost: 0 };
    entry.count += 1;
    if (functionName && id === functionName.toLowerCase()) entry.boost += 3;
    ids.set(id, entry);
  }
  const ranked = [...ids.values()]
    .sort((a, b) => (b.count + b.boost) - (a.count + a.boost) || b.name.length - a.name.length)
    .slice(0, 2);
  ranked.forEach((entry, index) => {
    const value = lang && index === 0 ? `${lang} ${entry.name}` : entry.name;
    pushCandidate(list, value, 4.75 - index * 0.1, 'code', 'code');
  });
  if (/\bfor\b[\s\S]{0,50}\bin\b[\s\S]{0,50}\bif\b/.test(text)) {
    pushCandidate(list, 'generator expression', 4.45, 'code', 'concept');
  } else if (/\breduce\b/.test(text)) {
    pushCandidate(list, 'array reduce', 4.4, 'code', 'concept');
  }
  const averageName = /(?:mean|average|avg)\s*\(/i.test(text);
  if (averageName) pushCandidate(list, 'average function', 4.2, 'code', 'concept');
}

function finishKeywords(candidates, limit) {
  const sorted = candidates
    .slice()
    .sort((a, b) => (b.weight - a.weight) || (b.value.length - a.value.length));
  const out = [];
  for (const candidate of sorted) {
    const value = candidate.value;
    const lower = value.toLowerCase();
    if (out.some((item) => item.toLowerCase() === lower)) continue;
    if (out.some((item) => item.toLowerCase().includes(lower) && item.length >= value.length + 2)) continue;
    for (let i = out.length - 1; i >= 0; i -= 1) {
      if (lower.includes(out[i].toLowerCase()) && value.length >= out[i].length + 2) {
        out.splice(i, 1);
      }
    }
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function extractRuleKeywords({ source, translation, domain = 'general', sourceLang = '', targetLang = '' }) {
  const topic = detectTopic({ source, translation, domain });
  const knownTerms = new Set([
    ...(DOMAIN_TERMS[domain] || []),
    ...(TOPIC_TERMS[topic] || []),
    ...GENERAL_TERMS,
  ].map((term) => term.toLowerCase()));
  const candidates = [];

  if (domain === 'code') {
    addCodeCandidates(candidates, source, translation);
  }

  for (const [origin, text] of [['source', source], ['translation', translation]]) {
    if (!text) continue;
    addTermCandidates(candidates, text, origin, domain, topic);
    addProperCandidates(candidates, text, origin, knownTerms);
  }

  const englishText = /^zh/i.test(sourceLang || '')
    ? (translation || '')
    : (source || translation || '');
  if (domain !== 'code' || candidates.length < 2) addContentCandidates(candidates, englishText);

  const combined = `${source || ''}\n${translation || ''}`;
  if (domain === 'math' && /\bintegral\b|∫|积分/i.test(combined) && /\bfrom\s+\d+\s+to\s+\d+\b|定积分/i.test(combined)) {
    pushCandidate(candidates, 'definite integral', 4.8, 'pattern', 'pattern');
  }
  if (domain === 'science' && /\bnewton'?s second law\b|牛顿第二定律/i.test(combined)) {
    pushCandidate(candidates, "Newton's second law", 5.0, 'pattern', 'pattern');
  }
  if (topic === 'product' && /(?:[$¥￥]\s?\d|usd|cny)/i.test(combined)) {
    pushCandidate(candidates, 'price', 4.2, 'pattern', 'pattern');
  }
  if (domain === 'code' && !candidates.length) {
    addContentCandidates(candidates, englishText);
  }

  return {
    keywords: finishKeywords(candidates, 4),
    topic,
  };
}

function siteKeysFor({ domain, topic, lang }) {
  if (domain === 'code') return ['stackoverflow', 'github'];
  if (domain === 'math') return ['scholar', 'wikipedia', 'wolfram'];
  if (topic === 'history') return ['wikipedia', 'bing'];
  if (topic === 'medical') {
    return domain === 'science'
      ? ['pubmed', 'scholar', 'wikipedia']
      : ['pubmed', 'wikipedia', 'bing'];
  }
  if (topic === 'legal') return ['wikipedia', 'bing'];
  if (topic === 'news') return ['bingnews', 'wikipedia', 'bing'];
  if (topic === 'product') {
    return lang === 'zh' ? ['bing', 'baidu', 'wikipedia'] : ['bing', 'wikipedia'];
  }
  if (domain === 'science') return ['scholar', 'wikipedia'];
  return lang === 'zh' ? ['wikipedia', 'bing', 'baidu'] : ['wikipedia', 'bing'];
}

function buildSearchLinks({ keywords, domain = 'general', topic = '', sourceLang = '', targetLang = '' }) {
  const words = (keywords || []).map(cleanKeyword).filter(Boolean);
  if (!words.length) return [];
  const lang = /^zh/i.test(sourceLang || '') ? 'zh' : 'en';
  const query = words.slice(0, 3).join(' ').trim();
  if (!query) return [];
  return siteKeysFor({ domain, topic, lang })
    .map((key) => {
      const def = SITE_DEFS[key];
      if (!def) return null;
      const host = typeof def.host === 'function' ? def.host(lang) : def.host;
      const url = def.url(query, lang);
      if (!isAllowedSearchUrl(url)) return null;
      return {
        key,
        site: def.site,
        description: def.description,
        host,
        query,
        url,
      };
    })
    .filter(Boolean);
}

function parseKeywordReply(text) {
  let value = String(text || '').trim();
  value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(value);
  } catch {
    const start = value.indexOf('[');
    const end = value.lastIndexOf(']');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(value.slice(start, end + 1)); } catch {}
    }
  }
  if (!Array.isArray(parsed) && parsed && Array.isArray(parsed.keywords)) parsed = parsed.keywords;
  if (!Array.isArray(parsed)) return [];
  const out = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const keyword = cleanKeyword(item);
    if (!keyword) continue;
    if (out.some((value0) => value0.toLowerCase() === keyword.toLowerCase())) continue;
    out.push(keyword);
    if (out.length >= 5) break;
  }
  return out;
}

function mergeKeywords(primary, fallback, limit = 5) {
  const candidates = [];
  (primary || []).forEach((value, index) => {
    pushCandidate(candidates, value, 5 - index * 0.01, 'ai', 'keyword');
  });
  (fallback || []).forEach((value, index) => {
    pushCandidate(candidates, value, 4.5 - index * 0.01, 'rules', 'keyword');
  });
  return finishKeywords(candidates, limit);
}

async function extractKeywordsAI({ provider, source, translation, domain = 'general', signal }) {
  if (!provider) throw new Error('未配置 AI 模型');
  const userText = `领域：${DOMAIN_LABELS[domain] || domain}\n原文：\n<<<\n${String(source || '').slice(0, 3000)}\n>>>\n\n译文：\n<<<\n${String(translation || '').slice(0, 3000)}\n>>>`;
  const text = await chat({
    provider,
    messages: [
      { role: 'system', content: KEYWORD_SYSTEM },
      { role: 'user', content: userText },
    ],
    maxTokens: 220,
    temperature: 0.2,
    timeoutMs: 12000,
    signal,
  });
  const keywords = parseKeywordReply(text);
  if (!keywords.length) throw new Error('模型没有返回可用关键词');
  return keywords;
}

function isAllowedSearchUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

module.exports = {
  KEYWORD_SYSTEM,
  SITE_DEFS,
  detectTopic,
  extractRuleKeywords,
  buildSearchLinks,
  mergeKeywords,
  parseKeywordReply,
  extractKeywordsAI,
  isAllowedSearchUrl,
};
