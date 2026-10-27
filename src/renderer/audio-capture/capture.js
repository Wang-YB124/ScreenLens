const api = window.screenlens;

let ctx = null;
let stream = null;
let sourceNode = null;
let processor = null;
let sink = null;
let segments = [];
let total = 0;
let overlapSamples = 0;
let chunkSamples = 0;
let sampleRate = 48000;
let flushing = false;
let running = false;
let statusTick = 0;

function sendStatus(payload) {
  try { api.send('audio:status', payload); } catch {}
}

async function start(config) {
  if (running) return;
  running = true;
  try {
    const source = config.source === 'microphone' ? 'microphone' : 'system';
    if (source === 'microphone') {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } else {
      if (!config.sourceId) throw new Error('没有找到屏幕捕获源');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: config.sourceId,
          },
        },
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: config.sourceId,
            maxWidth: 64,
            maxHeight: 64,
            maxFrameRate: 1,
          },
        },
      });
    }
    const audioTracks = stream.getAudioTracks();
    if (!audioTracks.length) throw new Error('没有捕获到音频轨道');
    const audioStream = new MediaStream(audioTracks);
    ctx = new AudioContext();
    try { await ctx.resume(); } catch {}
    sampleRate = ctx.sampleRate || 48000;
    const chunkMs = Math.max(2500, Math.min(8000, Number(config.chunkMs) || 6000));
    const overlapMs = Math.max(300, Math.min(1500, Number(config.overlapMs) || 800));
    chunkSamples = Math.max(1, Math.round((sampleRate * chunkMs) / 1000));
    overlapSamples = Math.min(chunkSamples - Math.round(sampleRate * 0.2), Math.round((sampleRate * overlapMs) / 1000));
    if (overlapSamples < 0) overlapSamples = 0;
    sourceNode = ctx.createMediaStreamSource(audioStream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
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
      if (total >= chunkSamples) flush();
    };
    sendStatus({ status: 'listening', source, sampleRate });
    setTimeout(() => {
      if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }, 700);
  } catch (err) {
    running = false;
    sendStatus({ status: 'error', message: String(err.message || err) });
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
    let sum = 0;
    let count = 0;
    let active = 0;
    for (let i = 0; i < combined.length; i += 4) {
      const value = combined[i];
      sum += value * value;
      if (Math.abs(value) >= 0.012) active += 1;
      count += 1;
    }
    const rms = Math.sqrt(sum / Math.max(1, count));
    const activeRatio = active / Math.max(1, count);
    if (rms >= 0.0025 && activeRatio >= 0.05) {
      const wav = encodeWav(combined, sampleRate);
      api.send('audio:chunk', wav.buffer);
      statusTick += 1;
      if (statusTick % 8 === 0) sendStatus({ status: 'listening', rms, activeRatio });
    } else {
      sendStatus({ status: 'silence', rms, activeRatio });
    }
    const keep = Math.min(overlapSamples, combined.length);
    const tail = keep ? combined.slice(combined.length - keep) : null;
    segments = tail ? [tail] : [];
    total = tail ? tail.length : 0;
  } catch (err) {
    sendStatus({ status: 'error', message: String(err.message || err) });
  } finally {
    flushing = false;
  }
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
}

api.on('audio:init', (config) => { start(config); });
api.on('audio:stop', () => stopCapture());