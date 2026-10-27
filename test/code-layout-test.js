const assert = require('assert');
const { normalizeCodeLayout } = require('../src/core/translate');

const flat = '```python\ndef total(prices): return sum(p for p in prices if p > 0)  # 只保留正数价格\n```';
const fixed = normalizeCodeLayout(flat);
assert.ok(fixed.includes('def total(prices):\n    return sum('), fixed);
assert.ok(fixed.includes('# 只保留正数价格'), fixed);

const valid = '```python\ndef total(prices):\n    return sum(p for p in prices if p > 0)\n```';
assert.strictEqual(normalizeCodeLayout(valid), valid);

const js = '```js\nfunction mean(values) {\n  return values.reduce((a, b) => a + b, 0) / values.length;\n}\n```';
assert.strictEqual(normalizeCodeLayout(js), js);

const classLine = '```python\nclass Box: pass\n```';
const classFixed = normalizeCodeLayout(classLine);
assert.ok(classFixed.includes('class Box:\n    pass'), classFixed);

const inlineIf = '```python\nif x: return y\n```';
assert.strictEqual(normalizeCodeLayout(inlineIf), inlineIf);

const noFence = 'def add(a, b): return a + b';
assert.strictEqual(normalizeCodeLayout(noFence), 'def add(a, b):\n    return a + b');

console.log('CODE_LAYOUT_OK');
console.log(fixed);