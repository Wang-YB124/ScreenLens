const fs = require('fs');
const path = require('path');
const http = require('http');
const vscode = require('vscode');
const { version } = require('./package.json');

let timer = null;
let lastSentAt = 0;
let statusItem = null;
let pollTimer = null;
let lastBridgeKey = '';
let output = null;
let lastErrorAt = 0;
let lastLogKey = '';

function log(message) {
  if (output) {
    output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
  }
}

function bridgeFile() {
  const configured = String(vscode.workspace.getConfiguration('screenlens').get('bridgeFile', '') || '').trim();
  if (configured) return configured;
  return path.join(process.env.APPDATA || '', 'ScreenLens', 'editor-bridge.json');
}

function readBridge() {
  try {
    const raw = fs.readFileSync(bridgeFile(), 'utf8');
    const info = JSON.parse(raw);
    if (!info || !Number(info.port) || !info.token) return null;
    return { port: Number(info.port), token: String(info.token) };
  } catch {
    return null;
  }
}

function postSnapshot(info, editor) {
  if (!info || !editor || !editor.document || editor.document.isClosed) return;
  const document = editor.document;
  const fullText = document.getText();
  if (!fullText.trim()) return;
  const cursorLine = editor.selection.active.line;
  let text = fullText;
  let lineOffset = 0;
  if (fullText.length > 60000) {
    const lines = fullText.split('\n');
    let start = Math.max(0, cursorLine - 600);
    const end = Math.min(lines.length, cursorLine + 900);
    text = lines.slice(start, end).join('\n');
    while (text.length > 60000 && start < cursorLine) {
      start += 100;
      text = lines.slice(start, end).join('\n');
    }
    if (text.length > 60000) text = text.slice(0, 60000);
    lineOffset = start;
  }
  const payload = JSON.stringify({
    type: 'snapshot',
    file: document.uri.scheme === 'file' ? document.uri.fsPath : document.fileName,
    languageId: document.languageId,
    version: document.version,
    text,
    totalLines: document.lineCount,
    lineOffset,
    cursor: {
      line: cursorLine - lineOffset,
      character: editor.selection.active.character,
    },
    selection: {
      start: {
        line: editor.selection.start.line - lineOffset,
        character: editor.selection.start.character,
      },
      end: {
        line: editor.selection.end.line - lineOffset,
        character: editor.selection.end.character,
      },
    },
    saved: false,
  });
  const req = http.request({
    host: '127.0.0.1',
    port: info.port,
    path: '/snapshot',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${info.token}`,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'User-Agent': `ScreenLens-Code/${version}`,
    },
    timeout: 3000,
  }, (res) => {
    res.resume();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      lastSentAt = Date.now();
      const key = `${info.port}:${document.fileName}`;
      if (key !== lastLogKey) {
        lastLogKey = key;
        log(`已同步 ${path.basename(document.fileName)}（${text.length} 字符）`);
      }
      return;
    }
    if (Date.now() - lastErrorAt > 8000) {
      lastErrorAt = Date.now();
      log(`同步失败：HTTP ${res.statusCode}（端口 ${info.port}）`);
    }
  });
  req.on('timeout', () => req.destroy());
  req.on('error', (err) => {
    if (Date.now() - lastErrorAt > 8000) {
      lastErrorAt = Date.now();
      log(`同步失败：${err.message}`);
    }
  });
  req.end(payload);
}

function updateStatus(info) {
  if (!statusItem) return;
  if (info) {
    statusItem.text = '$(sparkle) ScreenLens 代码字幕';
    statusItem.tooltip = 'ScreenLens 代码字幕已连接；写作时自动暂存并审阅代码';
    statusItem.show();
  } else {
    statusItem.hide();
  }
}

function schedule(editor) {
  const info = readBridge();
  updateStatus(info);
  if (!info || !editor) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const current = vscode.window.activeTextEditor;
    if (current && current.document === editor.document) postSnapshot(info, current);
  }, 400);
}

function startLiveBridge(context, outputChannel) {
  output = outputChannel || null;
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 40);
  statusItem.text = '$(sparkle) ScreenLens 代码字幕';
  statusItem.tooltip = '等待 ScreenLens 开启代码字幕';
  context.subscriptions.push(statusItem);

  const refresh = () => {
    const info = readBridge();
    updateStatus(info);
    if (info) {
      const key = `${info.port}:${info.token}`;
      if (key !== lastBridgeKey) {
        lastBridgeKey = key;
        lastLogKey = '';
        log(`已连接 ScreenLens 代码字幕桥接（端口 ${info.port}）`);
        if (vscode.window.activeTextEditor) schedule(vscode.window.activeTextEditor);
      }
    } else {
      if (lastBridgeKey) log('ScreenLens 代码字幕桥接已断开');
      lastBridgeKey = '';
      lastLogKey = '';
    }
  };
  refresh();
  pollTimer = setInterval(refresh, 2000);
  context.subscriptions.push({ dispose: () => clearInterval(pollTimer) });

  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor) schedule(editor);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument((event) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && event.document === editor.document) schedule(editor);
  }));
  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument((document) => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === document) schedule(editor);
  }));
}

module.exports = { startLiveBridge };
