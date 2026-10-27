const api = window.screenlens;
const scene = document.getElementById('scene');
const selection = document.getElementById('selection');
const hint = document.getElementById('hint');
const hintTitle = document.getElementById('hint-title');
const hintSub = document.getElementById('hint-sub');
const hintKeyWindow = document.getElementById('hint-key-window');
const tip = document.getElementById('tip');
const sizeLabel = document.getElementById('size');
const crossH = document.getElementById('cross-h');
const crossV = document.getElementById('cross-v');
const windowHover = document.getElementById('window-hover');
const windowTitle = document.getElementById('window-title');

let displayId = null;
let dragStart = null;
let currentRect = null;
let dragging = false;
let finished = false;
let windows = [];
let hoverWindowId = null;
let pressedWindow = null;
let moved = false;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pointFrom(event) {
  return {
    x: clamp(event.clientX, 0, window.innerWidth),
    y: clamp(event.clientY, 0, window.innerHeight),
  };
}

function applyRect(rect) {
  selection.style.left = `${rect.x}px`;
  selection.style.top = `${rect.y}px`;
  selection.style.width = `${rect.width}px`;
  selection.style.height = `${rect.height}px`;
  selection.style.backgroundSize = `${window.innerWidth}px ${window.innerHeight}px`;
  selection.style.backgroundPosition = `-${rect.x}px -${rect.y}px`;
  sizeLabel.textContent = `${Math.round(rect.width)} × ${Math.round(rect.height)}`;
}

function windowAt(point) {
  for (const item of windows) {
    const rect = item.rect;
    if (
      point.x >= rect.x
      && point.x <= rect.x + rect.width
      && point.y >= rect.y
      && point.y <= rect.y + rect.height
    ) {
      return item;
    }
  }
  return null;
}

function hideWindowHover() {
  hoverWindowId = null;
  windowHover.classList.add('hidden');
  document.body.classList.remove('window-hovering');
}

function showWindowHover(item) {
  if (!item) {
    hideWindowHover();
    return;
  }
  if (hoverWindowId === item.id && !windowHover.classList.contains('hidden')) return;
  hoverWindowId = item.id;
  const client = item.client;
  const left = clamp(client.x, 0, window.innerWidth);
  const top = clamp(client.y, 0, window.innerHeight);
  const right = clamp(client.x + client.width, 0, window.innerWidth);
  const bottom = clamp(client.y + client.height, 0, window.innerHeight);
  windowHover.style.left = `${left}px`;
  windowHover.style.top = `${top}px`;
  windowHover.style.width = `${Math.max(1, right - left)}px`;
  windowHover.style.height = `${Math.max(1, bottom - top)}px`;
  windowTitle.textContent = item.title || '窗口';
  windowHover.classList.remove('hidden');
  document.body.classList.add('window-hovering');
}

function resetSelection() {
  dragging = false;
  dragStart = null;
  currentRect = null;
  pressedWindow = null;
  moved = false;
  selection.classList.add('hidden');
  hint.classList.remove('hidden');
  document.body.classList.remove('dragging');
}

function submitWindow(item) {
  if (finished) return;
  finished = true;
  hideWindowHover();
  document.body.classList.add('closing');
  api.send('overlay:submit', {
    displayId,
    x: item.client.x,
    y: item.client.y,
    width: item.client.width,
    height: item.client.height,
    windowId: item.id,
    windowTitle: item.title,
  });
}

api.on('overlay:init', (payload) => {
  displayId = payload.displayId;
  windows = Array.isArray(payload.windows) ? payload.windows : [];
  if (payload.image) scene.style.backgroundImage = `url("${payload.image}")`;
  if (!payload.isFocus) {
    const title = hint.querySelector('.hint-copy strong');
    if (title) title.textContent = '点击此屏幕继续框选';
  } else if (windows.length) {
    hintTitle.textContent = '单击选择窗口 · 拖拽框选区域';
    hintSub.textContent = '选择窗口后持续识别该窗口 · 截图仅在本机处理';
    hintKeyWindow.classList.remove('hidden');
  }
  api.send('overlay:ready');
});

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || finished) return;
  const start = pointFrom(event);
  dragStart = start;
  pressedWindow = windowAt(start);
  moved = false;
  currentRect = { ...start, width: 0, height: 0 };
  dragging = true;
  hint.classList.add('hidden');
  selection.classList.remove('hidden');
  document.body.classList.add('dragging');
  applyRect(currentRect);
});

window.addEventListener('mousemove', (event) => {
  if (!dragging || !dragStart) {
    const point = pointFrom(event);
    crossH.style.top = `${point.y}px`;
    crossV.style.left = `${point.x}px`;
    if (windows.length && !finished) showWindowHover(windowAt(point));
    return;
  }
  const point = pointFrom(event);
  if (!moved) {
    const dx = point.x - dragStart.x;
    const dy = point.y - dragStart.y;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
      moved = true;
      hideWindowHover();
    }
  }
  const left = Math.min(dragStart.x, point.x);
  const top = Math.min(dragStart.y, point.y);
  currentRect = {
    x: left,
    y: top,
    width: Math.abs(point.x - dragStart.x),
    height: Math.abs(point.y - dragStart.y),
  };
  applyRect(currentRect);
});

window.addEventListener('mouseup', (event) => {
  if (!dragging || !currentRect) return;
  dragging = false;
  document.body.classList.remove('dragging');
  const rect = currentRect;
  if (!moved && pressedWindow) {
    submitWindow(pressedWindow);
    return;
  }
  if (rect.width < 8 || rect.height < 8) {
    resetSelection();
    return;
  }
  finished = true;
  hideWindowHover();
  selection.classList.add('confirm');
  document.body.classList.add('closing');
  api.send('overlay:submit', {
    displayId,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  });
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (finished) return;
    finished = true;
    document.body.classList.add('closing');
    api.send('overlay:cancel');
  }
});

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  if (finished) return;
  finished = true;
  document.body.classList.add('closing');
  api.send('overlay:cancel');
});

window.addEventListener('resize', () => {
  if (currentRect) applyRect(currentRect);
});

window.addEventListener('focus', () => {
  tip.classList.remove('hidden');
});

window.addEventListener('blur', () => {
  if (!dragStart) tip.classList.add('hidden');
});