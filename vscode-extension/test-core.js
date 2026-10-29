const http = require('http');
const assert = require('assert');
const { requestChat, stripCodeFence, normalizeEol, endpointOf } = require('./core');
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const data = JSON.parse(body || '{}');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '```python\ndef fixed():\n    return 1\n```' } }], model: data.model }));
  });
});
server.listen(11436, '127.0.0.1', async () => {
  try {
    const reply = await requestChat({ baseUrl: 'http://127.0.0.1:11436/v1', model: 'mock', messages: [{ role: 'user', content: 'test' }] });
    assert.strictEqual(stripCodeFence(reply), 'def fixed():\n    return 1');
    assert.strictEqual(normalizeEol('a\nb', '\r\n'), 'a\r\nb');
    assert.strictEqual(endpointOf('http://127.0.0.1:11436/v1'), 'http://127.0.0.1:11436/v1/chat/completions');
    console.log('CORE_TEST_OK');
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
