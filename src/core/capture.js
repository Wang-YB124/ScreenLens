const { desktopCapturer, nativeImage, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { markTiming } = require('./timing');

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

async function captureDisplays() {
  const displays = screen.getAllDisplays();
  const maxWidth = Math.max(
    ...displays.map((display) => Math.round(display.size.width * display.scaleFactor)),
  );
  const maxHeight = Math.max(
    ...displays.map((display) => Math.round(display.size.height * display.scaleFactor)),
  );
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: maxWidth, height: maxHeight },
    fetchWindowIcons: false,
  });
  return displays.map((display, index) => {
    let source = sources.find((item) => item.display_id === String(display.id));
    if (!source) source = sources[index] || sources[0];
    return { display, image: source?.thumbnail || null };
  });
}

async function captureDisplaysFast(ocr, tempDir, { timingId } = {}) {
  const displays = screen.getAllDisplays();
  const cursor = screen.getCursorScreenPoint();
  const focusId = screen.getDisplayNearestPoint(cursor).id;
  const ordered = displays.slice().sort((a, b) => {
    if (a.id === focusId) return -1;
    if (b.id === focusId) return 1;
    return 0;
  });
  const dir = path.join(tempDir, 'screens');
  fs.mkdirSync(dir, { recursive: true });
  const shots = [];
  for (const display of ordered) {
    const physical = screen.dipToScreenRect(null, display.bounds);
    const rect = {
      x: Math.round(physical.x),
      y: Math.round(physical.y),
      width: Math.round(physical.width),
      height: Math.round(physical.height),
    };
    const file = path.join(dir, `screen-${process.pid}-${display.id}.png`);
    const started = Date.now();
    let capture;
    try {
      capture = await ocr.captureRect(rect, file);
    } catch (err) {
      markTiming(timingId, 'display-capture-error', {
        displayId: display.id,
        message: String(err.message || '').slice(0, 120),
      });
      if (!shots.length) throw err;
      continue;
    }
    const readStarted = Date.now();
    const image = nativeImage.createFromPath(capture.path || file);
    const readMs = Date.now() - readStarted;
    try { fs.unlinkSync(capture.path || file); } catch {}
    if (image.isEmpty()) {
      if (!shots.length) throw new Error('屏幕截图读取失败');
      continue;
    }
    const size = image.getSize();
    if (size.width < 40 || size.height < 30) {
      if (!shots.length) throw new Error('屏幕截图尺寸异常');
      continue;
    }
    shots.push({
      display,
      image,
      captureMs: capture.captureMs || 0,
      readMs,
      totalMs: Date.now() - started,
    });
    markTiming(timingId, 'display-captured', {
      displayId: display.id,
      focus: display.id === focusId,
      captureMs: capture.captureMs || 0,
      readMs,
      totalMs: Date.now() - started,
      width: size.width,
      height: size.height,
    });
  }
  return shots;
}

function cropDisplayImage(displayShot, rect) {
  const { display, image } = displayShot;
  if (!image || image.isEmpty()) throw new Error('无法获取屏幕画面');
  const size = image.getSize();
  const scaleX = size.width / display.bounds.width;
  const scaleY = size.height / display.bounds.height;
  const left = clamp(
    Math.round((rect.x - display.bounds.x) * scaleX),
    0,
    Math.max(0, size.width - 1),
  );
  const top = clamp(
    Math.round((rect.y - display.bounds.y) * scaleY),
    0,
    Math.max(0, size.height - 1),
  );
  const width = clamp(Math.round(rect.width * scaleX), 1, size.width - left);
  const height = clamp(Math.round(rect.height * scaleY), 1, size.height - top);
  const cropped = image.crop({ x: left, y: top, width, height });
  return { image: cropped, scale: scaleX };
}

function dipToPhysicalRect(rect) {
  try {
    const converted = screen.dipToScreenRect(null, rect);
    return {
      x: Math.round(converted.x),
      y: Math.round(converted.y),
      width: Math.round(converted.width),
      height: Math.round(converted.height),
    };
  } catch {
    const display = screen.getDisplayMatching(rect);
    const scale = display.scaleFactor;
    return {
      x: Math.round(display.bounds.x + (rect.x - display.bounds.x) * scale),
      y: Math.round(display.bounds.y + (rect.y - display.bounds.y) * scale),
      width: Math.round(rect.width * scale),
      height: Math.round(rect.height * scale),
    };
  }
}

module.exports = { captureDisplays, captureDisplaysFast, cropDisplayImage, dipToPhysicalRect };
