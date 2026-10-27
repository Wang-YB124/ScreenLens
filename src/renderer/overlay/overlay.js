const api = window.screenlens;
const scene = document.getElementById('scene');
const selection = document.getElementById('selection');
const hint = document.getElementById('hint');
const tip = document.getElementById('tip');
const sizeLabel = document.getElementById('size');
const crossH = document.getElementById('cross-h');
const crossV = document.getElementById('cross-v');

let displayId = null;
let dragStart = null;
let currentRect = null;
let dragging = false;
let finished = false;

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

function resetSelection() {
  dragging = false;
  dragStart = null;
  currentRect = null;
  selection.classList.add('hidden');
  hint.classList.remove('hidden');
  document.body.classList.remove('dragging');
}

api.on('overlay:init', (payload) => {
  displayId = payload.displayId;
  if (payload.image) scene.style.backgroundImage = `url("${payload.image}")`;
  if (!payload.isFocus) {
    const title = hint.querySelector('.hint-copy strong');
    if (title) title.textContent = '点击此屏幕继续框选';
  }
  api.send('overlay:ready');
});

window.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || finished) return;
  dragStart = pointFrom(event);
  currentRect = { ...dragStart, width: 0, height: 0 };
  dragging = true;
  hint.classList.add('hidden');
  selection.classList.remove('hidden');
  document.body.classList.add('dragging');
  applyRect(currentRect);
});

window.addEventListener('mousemove', (event) => {
  if (!dragging || !dragStart) {
    crossH.style.top = `${event.clientY}px`;
    crossV.style.left = `${event.clientX}px`;
    return;
  }
  const point = pointFrom(event);
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
  if (rect.width < 8 || rect.height < 8) {
    resetSelection();
    return;
  }
  finished = true;
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
