const api = window.screenlens;

let ctx = null;
let stream = null;
let sourceNode = null;
let processor = null;
let sink = null;
let segments = [];
let total = 0;
let overlapSamples = 0;
let fullChunkSamples = 0;
let firstChunkSamples = 0;
let chunkSamples = 0;
let sampleRate = 48000;
let flushing = false;
let running = false;
let restarting = false;
let firstFlushDone = false;
let statusTick = 0;
let config = null;
let generation = 0;
let deviceBound = false;
let startedAt = 0;
let lastDeviceChange = 0;
let restartAttempt = false;
let newSamples = 0;
let quietBlocks = 0;

function sendStatus(payload) {
  try { api.send('audio:status', payload); } catch {}
}

function makeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function friendlyError(err, source) {
  const name = String(err?.name || '');
  const raw = String(err?.message || err || '');
  if (err?.code === 'unsupported-loopback') {
    return {
      code: 'unsupported',
      message: '当前系统或 Electron 版本没有返回系统声音回环轨道；请改用麦克风来源。',
    };
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || /permission|denied/i.test(raw)) {
    return {
      code: 'permission',
      message: source === 'microphone'
        ? '麦克风权限被拒绝，请在系统隐私设置中允许麦克风访问。'
        : '系统声音捕获权限被拒绝，请检查系统隐私/屏幕录制权限，或改用麦克风。',
    };
  }
  if (name === 'NotSupportedError' || name === 'TypeError' || /not supported|notsupported/i.test(raw)) {
    return {
      code: 'unsupported',
      message: source === 'microphone'
        ? '当前设备不支持麦克风采集。'
        : '当前系统或 Electron 不支持系统声音回环，请改用麦克风来源。',
    };
  }
  if (name === 'NotFoundError' || /requested device not found|no audio/i.test(raw)) {
    return {
      code: 'no-device',
      message: source === 'microphone'
        ? '没有找到可用的麦克风，请检查连接。'
        : '没有找到可用的系统输出设备，请检查扬声器/耳机连接。',
    };
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || /could not start|in use|busy/i.test(raw)) {
    return {
      code: 'busy',
      message: '音频设备被其他程序占用或无法读取，请关闭占用设备的程序后重试。',
    };
  }
  if (name === 'AbortError') {
    return { code: 'abort', message: '音频采集已取消。' };
  }
  return {
    code: 'unknown',
    message: `${source === 'microphone' ? '麦克风' : '系统声音'}采集失败：${raw.slice(0, 160) || '未知错误'}`,
  };
}

async function acquireStream(current) {
  if (current.source === 'microphone') {
    const media = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    const audioTracks = media.getAudioTracks();
    if (!audioTracks.length) {
      try { media.getTracks().forEach((track) => track.stop()); } catch {}
      throw makeError('no-device', '没有捕获到麦克风音频轨道');
    }
    return { media, audioTracks, source: 'microphone' };
  }

  const media = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
  const audioTracks = media.getAudioTracks();
  const videoTracks = media.getVideoTracks();
  videoTracks.forEach((track) => {
    try { track.stop(); } catch {}
    try { media.removeTrack(track); } catch {}
  });
  if (!audioTracks.length) {
    try { media.getTracks().forEach((track) => track.stop()); } catch {}
    throw makeError('unsupported-loopback', '系统声音回环没有返回音频轨道');
  }
  return { media, audioTracks, source: 'system' };
}

function trackInfo(audioTracks, source) {
  const track = audioTracks[0];
  let settings = {};
  try { settings = track.getSettings ? track.getSettings() : {}; } catch {}
  return {
    source,
    sampleRate: settings.sampleRate || sampleRate,
    trackLabel: String(track.label || ''),
    channelCount: Number(settings.channelCount) || 0,
    deviceId: String(settings.deviceId || ''),
  };
}

function audioStats(samples) {
  let sum = 0;
  let count = 0;
  let active = 0;
  for (let i = 0; i < samples.length; i += 4) {
    const value = samples[i];
    sum += value * value;
    if (Math.abs(value) >= 0.012) active += 1;
    count += 1;
  }
  return {
    rms: Math.sqrt(sum / Math.max(1, count)),
    activeRatio: active / Math.max(1, count),
  };
}

function setupGraph(audioTracks, info) {
  try {
    ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
  } catch {
    ctx = new AudioContext();
  }
  ctx.resume().catch(() => {});
  sampleRate = ctx.sampleRate || 48000;
  const chunkMs = Math.max(1500, Math.min(12000, Number(config.chunkMs) || 6000));
  const firstMs = Math.max(800, Math.min(chunkMs, Number(config.firstChunkMs) || 2000));
  const overlapMs = Math.max(300, Math.min(2500, Number(config.overlapMs) || 800));
  fullChunkSamples = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
  firstChunkSamples = Math.max(1, Math.round((sampleRate * firstMs) / 1000));
  chunkSamples = firstFlushDone ? fullChunkSamples : firstChunkSamples;
  overlapSamples = Math.max(0, Math.round((sampleRate * overlapMs) / 1000));
  segments = [];
  total = 0;
  newSamples = 0;
  quietBlocks = 0;
  sourceNode = ctx.createMediaStreamSource(new MediaStream(audioTracks));
  processor = ctx.createScriptProcessor(2048, 1, 1);
  sink = ctx.createGain();
  sink.gain.value = 0;
  sourceNode.connect(processor);
  processor.connect(sink);
  sink.connect(ctx.destination);
  processor.onaudioprocess = (event) => {
    if (!running || flushing) return;
    const input = event.inputBuffer.getChannelData(0);
    const copy = new Float32Array(input.length);
    copy.set(input);
    segments.push(copy);
    total += copy.length;
    newSamples += copy.length;
    let energy = 0;
    let count = 0;
    for (let i = 0; i < copy.length; i += 4) {
      energy += copy[i] * copy[i];
      count += 1;
    }
    const blockRms = Math.sqrt(energy / Math.max(1, count));
    quietBlocks = blockRms < 0.0045 ? quietBlocks + 1 : 0;
    const minFlush = config.sentence
      ? Math.max(Math.round(sampleRate * 1.2), Math.round(chunkSamples * 0.15))
      : Math.round(chunkSamples * 0.65);
    const minNew = Math.round(Math.max(0, chunkSamples - overlapSamples) * (config.sentence ? 0.15 : 0.55));
    const quietTarget = 2;
    if (total >= chunkSamples || (total >= minFlush && newSamples >= minNew && quietBlocks >= quietTarget)) {
      flush();
    }
  };
  sendStatus({
    status: 'listening',
    source: info.source,
    sampleRate,
    trackLabel: info.trackLabel,
    channelCount: info.channelCount,
    deviceId: info.deviceId,
  });
  setTimeout(() => {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  }, 700);
}

async function start(nextConfig) {
  if (running) return;
  config = nextConfig;
  running = true;
  startedAt = Date.now();
  firstFlushDone = false;
  flushing = false;
  segments = [];
  total = 0;
  const gen = ++generation;
  if (!deviceBound) {
    deviceBound = true;
    try {
      navigator.mediaDevices.addEventListener('devicechange', onDeviceChange);
    } catch {}
  }
  try {
    const acquired = await acquireStream(config);
    if (gen !== generation || !running) {
      try { acquired.media.getTracks().forEach((track) => track.stop()); } catch {}
      return;
    }
    stream = acquired.media;
    const info = trackInfo(acquired.audioTracks, acquired.source);
    setupGraph(acquired.audioTracks, info);
  } catch (err) {
    if (gen !== generation || !running) return;
    running = false;
    const friendly = friendlyError(err, config.source);
    const failed = restartAttempt
      ? {
        code: 'device-change-failed',
        message: '输出设备已切换，自动重连失败；请重新开启音频字幕。',
      }
      : friendly;
    sendStatus({ status: 'error', code: failed.code, message: failed.message });
    stopCapture();
  }
}

function flush() {
  if (flushing || !total) return;
  flushing = true;
  try {
    const combined = new Float32Array(total);
    let offset = 0;
    for (const segment of segments) {
      combined.set(segment, offset);
      offset += segment.length;
    }
    const isFirst = !firstFlushDone;
    const stats = audioStats(combined);
    const freshCount = Math.min(newSamples, combined.length);
    const fresh = freshCount > 0 && freshCount < combined.length
      ? audioStats(combined.subarray(combined.length - freshCount))
      : stats;
    const voiced = isFirst
      ? (stats.rms >= 0.0025 && stats.activeRatio >= 0.05)
      : (fresh.rms >= 0.0025 && fresh.activeRatio >= 0.04);
    if (voiced) {
      const wav = encodeWav(combined, sampleRate);
      api.send('audio:chunk', wav.buffer);
      statusTick += 1;
      if (statusTick % 8 === 0) {
        sendStatus({ status: 'listening', rms: fresh.rms, activeRatio: fresh.activeRatio, sampleRate });
      }
    } else {
      sendStatus({ status: 'silence', rms: fresh.rms, activeRatio: fresh.activeRatio, sampleRate });
    }
    firstFlushDone = true;
    chunkSamples = fullChunkSamples;
    newSamples = 0;
    quietBlocks = 0;
    const keep = Math.min(overlapSamples, combined.length);
    const tail = keep ? combined.slice(combined.length - keep) : null;
    segments = tail ? [tail] : [];
    total = tail ? tail.length : 0;
  } catch (err) {
    sendStatus({ status: 'error', code: 'flush', message: String(err.message || err) });
  } finally {
    flushing = false;
  }
}

async function restartCapture() {
  if (restarting || !running || !config) return;
  restarting = true;
  sendStatus({
    status: 'device-change',
    message: config.source === 'microphone'
      ? '音频设备已切换，正在重新连接…'
      : '输出设备已切换，正在重新连接…',
  });
  const saved = config;
  stopCapture();
  restartAttempt = true;
  await start(saved);
  restartAttempt = false;
  restarting = false;
}

function onDeviceChange() {
  if (!running || restarting) return;
  if (Date.now() - startedAt < 1500) return;
  if (Date.now() - lastDeviceChange < 1000) return;
  lastDeviceChange = Date.now();
  setTimeout(() => {
    if (running && !restarting) restartCapture();
  }, 350);
}

function encodeWav(samples, rate) {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, value < 0 ? value * 0x8000 : value * 0x7FFF, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}

function stopCapture() {
  running = false;
  generation += 1;
  try { if (processor) { processor.onaudioprocess = null; processor.disconnect(); } } catch {}
  try { if (sourceNode) sourceNode.disconnect(); } catch {}
  try { if (sink) sink.disconnect(); } catch {}
  try { if (stream) stream.getTracks().forEach((track) => track.stop()); } catch {}
  try { if (ctx && ctx.state !== 'closed') ctx.close(); } catch {}
  stream = null;
  processor = null;
  sourceNode = null;
  sink = null;
  ctx = null;
  segments = [];
  total = 0;
  quietBlocks = 0;
  newSamples = 0;
  flushing = false;
}

api.on('audio:init', (nextConfig) => { start(nextConfig); });
api.on('audio:stop', () => stopCapture());
