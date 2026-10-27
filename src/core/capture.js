const { desktopCapturer, screen } = require('electron');

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

module.exports = { captureDisplays, cropDisplayImage, dipToPhysicalRect };
