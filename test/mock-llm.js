const http = require('http');

const PORT = Number(process.env.MOCK_PORT || 11435);

const EXPLAIN_GENERAL = `## 这是什么

这段文字在描述**实时翻译**的工作方式：选区保持不变，画面里的文字一旦变化，就会自动重新识别并翻译。

- 关键点一：识别与翻译分开进行，字幕只显示最新结果
- 关键点二：字幕条始终置顶，不影响观看视频
- 关键点三：重复内容会命中缓存，减少请求

\`\`\`js
const caption = await screenlens.capture(region);
translate(caption.text, "zh-CN");
\`\`\`

> 提示：按 Ctrl+Alt+R 可以停止实时字幕。

参考：[使用说明](https://example.com/docs)`;

const EXPLAIN_MATH = `## 这是什么

这是圆的面积与球的体积公式，属于**几何**中的基本结论。

$$S = \\pi r^2$$

$$V = \\frac{4}{3}\\pi r^3$$

- $S$ 表示圆的面积，$r$ 是半径
- $V$ 表示球的体积，$\\pi \\approx 3.14159$
- 两式都假设空间是平坦的欧氏几何

> 如果 OCR 漏掉了指数或分母，请以原图为准。`;

const EXPLAIN_SCIENCE = `## 这是什么

这段内容在描述**光合作用**：植物把光能转化为化学能，并储存在有机物中。

- 发生场所：叶绿体
- 核心输入：光、二氧化碳、水
- 主要输出：有机物与氧气
- 常见误区：光合作用并不等同于呼吸作用，两者方向相反

> 科普内容中的模型和比喻不等于严格结论。`;

const EXPLAIN_CODE = `## 这是什么

这是一段 JavaScript 函数，用于计算数组的平均值。

\`\`\`js
function mean(values) {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
\`\`\`

- 输入：一个数值数组 \`values\`
- 输出：算术平均值；空数组会得到 \`NaN\`
- 关键步骤：\`reduce\` 先求和，再除以长度
- 风险：没有处理空数组和非数字元素`;

const TRANSLATIONS = {
  general: '这是由本地 Mock 模型生成的 AI 译文：屏幕内容已经被理解并翻译。',
  math: '圆的面积是 $S = \\pi r^2$，球的体积是 $$V = \\frac{4}{3}\\pi r^3$$，其中 $r$ 是半径。',
  science: '光合作用把光能转化为化学能，主要发生在叶绿体中，并释放氧气。',
  code: '```js\n// 计算平均值\nfunction mean(values) {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n```',
};

const MODEL_CONTENT = {
  'mock-python': {
    translation: '```python\n# 只保留正数价格\ndef total(prices):\n    return sum(p for p in prices if p > 0)\n```',
    explanation: `## 这是什么

这是一个 Python 函数，用于计算列表中正数价格的总和。

\`\`\`python
def total(prices):
    return sum(p for p in prices if p > 0)
\`\`\`

- 输入：可迭代的数值序列 \`prices\`
- 输出：所有大于 0 的价格之和；没有正数时返回 \`0\`
- 关键点：\`sum(... for ... in ... if ...)\` 是生成器表达式
- 风险：\`None\` 或字符串元素会抛出 \`TypeError\``,
    keywords: ['Python total function', 'generator expression', 'positive prices'],
  },
  'mock-calculus': {
    translation: `导数是 $f'(x) = 3x^2 - 4x + 1$；从 0 到 1 的定积分为

$$\\int_0^1 (3x^2 - 4x + 1)\\,dx = 0$$`,
    explanation: `## 这是什么

这是对一个多项式求导并计算定积分的例子。

$$f'(x) = 3x^2 - 4x + 1$$

- 原函数：$F(x) = x^3 - 2x^2 + x$
- 代入上下限：$F(1) - F(0) = (1 - 2 + 1) - 0 = 0$
- 几何意义：曲线在 $[0,1]$ 上的有向面积之和为 0

> OCR 可能丢失积分号或指数；公式以原图为准。`,
    keywords: ['derivative', 'definite integral', 'calculus'],
  },
  'mock-physics': {
    translation: `牛顿第二定律：$F = ma$。对质量为 $3\\ \\mathrm{kg}$ 的物体施加 $12\\ \\mathrm{N}$ 的合力，会产生 $4\\ \\mathrm{m/s^2}$ 的加速度。`,
    explanation: `## 这是什么

这是牛顿第二定律的一个直接应用：合力等于质量乘以加速度。

$$F = ma \\quad\\Rightarrow\\quad a = \\frac{F}{m}$$

- 已知：$F = 12\\ \\mathrm{N}$，$m = 3\\ \\mathrm{kg}$
- 计算：$a = 12 / 3 = 4\\ \\mathrm{m/s^2}$
- 单位：$1\\ \\mathrm{N} = 1\\ \\mathrm{kg\\cdot m/s^2}$
- 前提：质量不变、惯性参考系、合力方向与加速度方向一致`,
    keywords: ["Newton's second law", 'acceleration', 'force and mass'],
  },
  'mock-en-long': {
    translation: '好的屏幕翻译器会保留原文的排版，保留专业术语，并解释习语，而不是逐字强行翻译。',
    explanation: `## 这是什么

这段话在说明一个好的屏幕翻译器应具备的三项能力。

- 保留排版：让译文仍能对应原文的位置和层级
- 保留术语：技术名词不随意意译，避免歧义
- 解释习语：习语需要说明含义，而不是逐字直译

> 逐字翻译容易丢失语气和上下文，阅读时应结合原句判断。`,
    keywords: ['screen translator', 'technical terms', 'idioms'],
  },
  'mock-science': {
    translation: '光合作用把光能转化为化学能，主要发生在叶绿体中，并释放氧气。',
    explanation: EXPLAIN_SCIENCE,
    keywords: ['photosynthesis', 'chloroplasts', 'oxygen'],
  },
  'mock-bad-keywords': {
    translation: '阿尔伯特·爱因斯坦是出生于德国的理论物理学家，因创立相对论而闻名。他于 1921 年获得诺贝尔物理学奖。',
    explanation: `## 这是什么

这是对阿尔伯特·爱因斯坦的简介：他是一位出生于德国的理论物理学家，以相对论闻名。

- 生卒：1879–1955
- 代表工作：狭义与广义相对论、光电效应
- 荣誉：1921 年诺贝尔物理学奖
- 背景：20 世纪现代物理学的重要奠基人之一

> 历史人物与事件的细节请以权威资料为准。`,
    keywords: 'not a json array',
  },
  'mock-medical': {
    translation: '根据医疗法，治疗前必须取得知情同意。患者必须在签署同意书前了解风险、益处和替代方案。',
    explanation: `## 这是什么

这段文字说明医疗法中的**知情同意**：治疗前必须让患者了解风险、益处和替代方案。

- 核心原则：患者自主决定
- 必要信息：风险、益处、替代方案
- 形式：签署同意书
- 例外：紧急救治等特殊情形需依当地法律判断

> 医疗与法律问题请咨询专业医生和律师。`,
    keywords: ['medical law', 'informed consent', 'treatment risks'],
  },
  'mock-news': {
    translation: 'OpenAI 周二发布了一款新模型，称其提升了推理能力，同时降低了开发者的延迟。',
    explanation: `## 这是什么

这是一则产品发布消息：OpenAI 发布新模型，强调推理能力提升与延迟降低。

- 发布方：OpenAI
- 重点：推理能力、开发者延迟
- 背景：模型竞争持续关注性能与成本
- 注意：官方参数与实际体验可能不同

> 新闻内容可能继续更新，请以官方发布为准。`,
    keywords: ['OpenAI new model', 'reasoning', 'latency'],
  },
  'mock-product': {
    translation: 'AeroBook 14 重 1.2 千克，提供 18 小时电池续航，起售价 899 美元。',
    explanation: `## 这是什么

这是 AeroBook 14 的产品参数摘要。

- 重量：1.2 kg
- 续航：18 小时
- 起售价：899 美元
- 定位：轻薄长续航笔记本

> 价格和配置可能因地区与版本不同。`,
    keywords: ['AeroBook 14', 'battery life', 'price'],
  },
};

const DOMAIN_KEYWORDS = {
  general: ['screen translation', 'technical terms', 'context'],
  code: ['JavaScript mean', 'array reduce', 'average function'],
  math: ['derivative', 'integral', 'calculus'],
  science: ['photosynthesis', 'chloroplasts', 'oxygen'],
};

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    if (!req.url.includes('/chat/completions')) {
      json(res, 404, { error: { message: 'not found' } });
      return;
    }
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const messages = body.messages || [];
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const userMessage = messages.find((m) => m.role === 'user');
    const parts = Array.isArray(userMessage?.content) ? userMessage.content : [];
    const hasImage = parts.some((part) => part.type === 'image_url');
    const user = parts.length
      ? parts.filter((part) => part.type === 'text').map((part) => part.text || '').join('\n')
      : String(userMessage?.content || '');
    const isTest = user.includes('请只回复：OK');
    const isKeywords = /search-keyword extractor/i.test(system);
    const isTranslation = system.includes('screen-text translator');
    const isExplain = !isTranslation;

    let domain = 'general';
    if (user.includes('领域：数学')) domain = 'math';
    else if (user.includes('领域：代码')) domain = 'code';
    else if (user.includes('领域：科普')) domain = 'science';
    else if (/mathematical content|likely mathematics/i.test(system)) domain = 'math';
    else if (/source code|likely code/i.test(system)) domain = 'code';
    else if (/popular-science|likely popular science/i.test(system)) domain = 'science';

    const scenario = MODEL_CONTENT[body.model];
    let content = isTranslation ? TRANSLATIONS[domain] : EXPLAIN_GENERAL;
    if (!isTranslation) {
      if (domain === 'math') content = EXPLAIN_MATH;
      else if (domain === 'science') content = EXPLAIN_SCIENCE;
      else if (domain === 'code') content = EXPLAIN_CODE;
    }
    if (scenario) content = isTranslation ? scenario.translation : scenario.explanation;

    console.log(`REQ stream=${Boolean(body.stream)} test=${isTest} keywords=${isKeywords} explain=${isExplain} domain=${domain} image=${hasImage} model=${body.model} chars=${user.length}`);

    if (isTest) {
      json(res, 200, {
        id: 'mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }],
      });
      return;
    }

    if (isKeywords) {
      const keywords = scenario?.keywords;
      const keywordContent = typeof keywords === 'string'
        ? keywords
        : JSON.stringify(Array.isArray(keywords) ? keywords : (DOMAIN_KEYWORDS[domain] || DOMAIN_KEYWORDS.general));
      json(res, 200, {
        id: 'mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content: keywordContent }, finish_reason: 'stop' }],
      });
      return;
    }

    if (!body.stream) {
      json(res, 200, {
        id: 'mock',
        object: 'chat.completion',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    let index = 0;
    const timer = setInterval(() => {
      if (index >= content.length) {
        res.write('data: [DONE]\n\n');
        res.end();
        clearInterval(timer);
        return;
      }
      const chunk = content.slice(index, index + 4);
      index += 4;
      res.write(`data: ${JSON.stringify({
        id: 'mock',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
      })}\n\n`);
    }, 22);
    res.on('close', () => {
      if (!res.writableEnded) clearInterval(timer);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MOCK_LLM listening on http://127.0.0.1:${PORT}/v1`);
});
