const assert = require('assert');
const {
  extractRuleKeywords,
  buildSearchLinks,
  parseKeywordReply,
  mergeKeywords,
  isAllowedSearchUrl,
} = require('../src/core/search');

const CASES = [
  {
    name: 'science-en',
    source: 'Photosynthesis converts light energy into chemical energy in chloroplasts and releases oxygen.',
    translation: '光合作用把光能转化为化学能，主要发生在叶绿体中，并释放氧气。',
    domain: 'science',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['photosynthesis', 'chloroplast', 'oxygen'],
    topic: '',
    sites: ['scholar', 'wikipedia'],
  },
  {
    name: 'zh-tech',
    source: '实时字幕会持续截取屏幕上的文字，并在内容变化时自动刷新翻译结果。',
    translation: 'Live captions continuously capture the text on the screen and automatically refresh the translation as the content changes.',
    domain: 'general',
    sourceLang: 'zh-CN',
    targetLang: 'en',
    expect: ['实时字幕', '自动刷新'],
    topic: '',
    sites: ['wikipedia', 'bing', 'baidu'],
  },
  {
    name: 'python',
    source: 'def total(prices) ：return sum(p 不 or p 1n prices 土 p > 0 ）keep only posltive pmces',
    translation: '# 只保留正数价格\ndef total(prices):\n    return sum(p for p in prices if p > 0)',
    domain: 'code',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['python', 'total', 'generator'],
    topic: '',
    sites: ['stackoverflow', 'github'],
  },
  {
    name: 'calculus',
    source: "Derivative: f'(x) = 3x2 - 4x + 1\nIntegral from 0 to 1:\nf (3x2 - 4x + 1) dx = 0",
    translation: '导数是 f\'(x) = 3x^2 - 4x + 1；从 0 到 1 的定积分为 ∫ (3x^2 - 4x + 1) dx = 0',
    domain: 'math',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['derivative', 'integral'],
    topic: '',
    sites: ['scholar', 'wikipedia', 'wolfram'],
  },
  {
    name: 'physics',
    source: "Newton's second law: F = ma.\nA 12 N net force on a 3 kg mass\nproduces an acceleration of 4 m/s2.",
    translation: '牛顿第二定律：F = ma。对质量为 3 kg 的物体施加 12 N 的合力，会产生 4 m/s² 的加速度。',
    domain: 'science',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['newton', 'acceleration', 'force'],
    topic: '',
    sites: ['scholar', 'wikipedia'],
  },
  {
    name: 'history',
    source: 'Albert Einstein was a German-born theoretical physicist, widely known for developing the theory of relativity. He received the Nobel Prize in Physics in 1921.',
    translation: '阿尔伯特·爱因斯坦是出生于德国的理论物理学家，因创立相对论而闻名。他于 1921 年获得诺贝尔物理学奖。',
    domain: 'science',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['albert einstein', 'relativity', 'physicist'],
    topic: 'history',
    sites: ['wikipedia', 'bing'],
  },
  {
    name: 'medical-law',
    source: 'Under medical law, informed consent is required before treatment. Patients must understand the risks, benefits, and alternatives before signing the consent form.',
    translation: '根据医疗法，治疗前必须取得知情同意。患者必须在签署同意书前了解风险、益处和替代方案。',
    domain: 'general',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['medical law', 'informed consent', 'treatment'],
    topic: 'medical',
    sites: ['pubmed', 'wikipedia', 'bing'],
  },
  {
    name: 'news',
    source: 'OpenAI announced a new model on Tuesday, saying it improves reasoning while reducing latency for developers.',
    translation: 'OpenAI 周二发布了一款新模型，称其提升了推理能力，同时降低了开发者的延迟。',
    domain: 'general',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['openai', 'model', 'reasoning', 'latency'],
    topic: 'news',
    sites: ['bingnews', 'wikipedia', 'bing'],
  },
  {
    name: 'product',
    source: 'The AeroBook 14 weighs 1.2 kg, offers 18 hours of battery life, and starts at $899.',
    translation: 'AeroBook 14 重 1.2 千克，提供 18 小时电池续航，起售价 899 美元。',
    domain: 'general',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['aerobook 14', 'battery life', 'price'],
    topic: 'product',
    sites: ['bing', 'wikipedia'],
  },
  {
    name: 'long-en',
    source: 'A good screen translator keeps the layout of the original text, preserves technical terms, and explains idioms instead of translating them word by word.',
    translation: '好的屏幕翻译器会保留原文的排版，保留专业术语，并解释习语，而不是逐字强行翻译。',
    domain: 'general',
    sourceLang: 'en',
    targetLang: 'zh-CN',
    expect: ['screen translator', 'technical terms', 'idioms'],
    topic: '',
    sites: ['wikipedia', 'bing'],
  },
];

let failed = 0;

for (const item of CASES) {
  const result = extractRuleKeywords(item);
  const keywords = result.keywords;
  const links = buildSearchLinks({
    keywords,
    domain: item.domain,
    topic: result.topic,
    sourceLang: item.sourceLang,
    targetLang: item.targetLang,
  });
  const joined = keywords.join(' | ').toLowerCase();
  const missing = item.expect.filter((word) => !joined.includes(word.toLowerCase()));
  const siteKeys = links.map((link) => link.key);
  const badLinks = links.filter((link) => (
    !/^https:\/\//.test(link.url)
    || /\s/.test(link.url)
    || /[\u3400-\u9fff]/.test(link.url)
    || !isAllowedSearchUrl(link.url)
  ));
  const ok = missing.length === 0
    && result.topic === item.topic
    && siteKeys.join(',') === item.sites.join(',')
    && links.length === item.sites.length
    && badLinks.length === 0
    && keywords.length >= 2;
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${item.name.padEnd(12)} topic=${result.topic || '-'} keywords=${JSON.stringify(keywords)} sites=${siteKeys.join(',')}`);
  if (missing.length) console.log(`     missing=${JSON.stringify(missing)}`);
  if (siteKeys.join(',') !== item.sites.join(',')) console.log(`     sites expected=${item.sites.join(',')}`);
  if (badLinks.length) console.log(`     bad links=${JSON.stringify(badLinks)}`);
}

const parsed = parseKeywordReply('```json\n["Albert Einstein", "theory of relativity", "Nobel Prize in Physics"]\n```');
assert.deepStrictEqual(parsed, ['Albert Einstein', 'theory of relativity', 'Nobel Prize in Physics']);
assert.deepStrictEqual(parseKeywordReply('not a json array'), []);
const merged = mergeKeywords(['Photosynthesis'], ['photosynthesis', 'chloroplasts', 'oxygen']);
assert.strictEqual(merged.length, 3);
assert.strictEqual(merged.filter((word) => word.toLowerCase() === 'photosynthesis').length, 1);
assert.strictEqual(isAllowedSearchUrl('https://en.wikipedia.org/wiki/Physics'), true);
assert.strictEqual(isAllowedSearchUrl('http://en.wikipedia.org/wiki/Physics'), false);
assert.strictEqual(isAllowedSearchUrl('https://example.com/?q=physics'), false);
console.log('HELPERS OK');

if (failed) {
  console.error(`FAILED ${failed}/${CASES.length}`);
  process.exitCode = 1;
} else {
  console.log(`PASS ${CASES.length}/${CASES.length}`);
}
