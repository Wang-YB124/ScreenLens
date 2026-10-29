const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'app:state',
  'app:quit',
  'settings:update',
  'provider:test',
  'provider:key',
  'action:select',
  'action:realtime',
  'action:stop-realtime',
  'action:retranslate',
  'action:set-target',
  'action:explain',
  'action:set-domain',
  'action:related',
  'search:open',
  'action:open-history',
  'action:close-result',
  'action:copy',
  'action:open-settings',
  'action:open-data',
  'action:remove-history',
  'action:clear-history',
  'action:open-external',
  'result:get',
  'result:pin',
  'window:minimize',
  'window:maximize',
  'window:close',
  'window:hide',
  'realtime:settings',
  'realtime:reset-size',
  'action:restart-ocr',
  'action:audio',
  'audio:records-path',
  'audio:choose-record-dir',
  'audio:reset-record-dir',
  'audio:records-open',
  'audio:records-open-file',
]);

const SEND_CHANNELS = new Set([
  'overlay:submit',
  'overlay:cancel',
  'overlay:ready',
  'overlay:frame',
  'realtime:resize',
  'realtime:hitzone',
  'realtime:drag-start',
  'realtime:drag-move',
  'realtime:drag-end',
  'realtime:resize-start',
  'realtime:resize-move',
  'realtime:resize-end',
  'window:focus',
  'audio:chunk',
  'audio:status',
]);

const EVENT_CHANNELS = new Set([
  'app:state-changed',
  'app:navigate',
  'result:show',
  'result:state',
  'result:delta',
  'realtime:init',
  'realtime:update',
  'audio:init',
  'audio:stop',
  'overlay:init',
  'overlay:shown',
  'overlay:windows',
  'overlay:reset',
  'toast',
]);

contextBridge.exposeInMainWorld('screenlens', {
  invoke(channel, ...args) {
    if (!INVOKE_CHANNELS.has(channel)) {
      return Promise.reject(new Error(`Blocked channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, payload) {
    if (!SEND_CHANNELS.has(channel)) return;
    ipcRenderer.send(channel, payload);
  },
  on(channel, callback) {
    if (!EVENT_CHANNELS.has(channel) || typeof callback !== 'function') return () => {};
    const listener = (event, ...args) => callback(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  platform: process.platform,
});
