const { detectDomain } = require('../src/core/domain');

const cases = [
  ['code-js', 'function add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nconsole.log(add(1, 2));', 'code'],
  ['code-py', 'def mean(values):\n    total = sum(values)\n    return total / len(values)\n', 'code'],
  ['code-py-ocr', 'def total(prices) ：return sum(p 不 or p 1n prices 土 p > 0 ）keep only posltive pmces', 'code'],
  ['code-html', '<div class="card">\n  <h2>Hello</h2>\n</div>', 'code'],
  ['code-sh', 'git status\nnpm install\nchmod +x run.sh', 'code'],
  ['code-css', '.card {\n  color: #fff;\n  border-radius: 12px;\n}', 'code'],
  ['math-euler', 'eiπ + 1 = 0, where e is the base of the natural logarithm.', 'math'],
  ['math-formula', '∫_0^1 x^2 dx = 1/3', 'math'],
  ['math-latex', '\\frac{a+b}{2} \\ge \\sqrt{ab}', 'math'],
  ['math-ocr-garbled', '2\nThe area Of a circle = Ttr ·The volume 0f a sphere is V = （4 / 3 ）丌 r3', 'math'],
  ['math-word', '由勾股定理可得 a² + b² = c²，其中 c 为斜边。', 'math'],
  ['science', '量子纠缠描述两个粒子之间的非局域关联，测量其中一个会影响另一个的状态。', 'science'],
  ['science-en', 'Photosynthesis converts light energy into chemical energy in chloroplasts.', 'science'],
  ['science-physics', "Newton's second law: F = ma. A 12 N net force on a 3 kg mass produces an acceleration of 4 m/s².", 'science'],
  ['science-physics-cn', '牛顿第二定律表明，合外力与加速度成正比，与质量成反比。', 'science'],
  ['general', 'The quick brown fox jumps over the lazy dog.', 'general'],
  ['general-cn', '今天下午三点开会，请提前准备材料。', 'general'],
  ['mixed', '这个函数的复杂度是 O(n log n)，其中 n 是输入数组的长度。', 'general'],
];

let failed = 0;
for (const [name, text, expected] of cases) {
  const actual = detectDomain(text);
  const ok = actual === expected;
  if (!ok) failed += 1;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${name.padEnd(14)} expected=${expected.padEnd(8)} actual=${actual}`);
}
process.exitCode = failed ? 1 : 0;
