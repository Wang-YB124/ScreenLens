let seq = 0;
const entries = new Map();
const MAX_ENTRIES = 80;

function emit(id, phase, extra) {
  const entry = entries.get(id);
  const now = Date.now();
  const base = entry ? entry.clickAt : now;
  const payload = {
    id,
    phase,
    at: now,
    sinceClick: now - base,
    ...(entry ? entry.meta : {}),
    ...(extra || {}),
  };
  console.log('[timing]', JSON.stringify(payload));
}

function startTiming(kind, extra = {}) {
  const id = `${kind}-${Date.now().toString(36)}-${++seq}`;
  const clickedAt = Number(extra.clickedAt) || Date.now();
  const { clickedAt: _ignored, ...meta } = extra;
  entries.set(id, { kind, clickAt: clickedAt, startedAt: Date.now(), meta });
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  emit(id, 'begin', { ipcDelayMs: Date.now() - clickedAt });
  const timer = setTimeout(() => entries.delete(id), 120000);
  if (typeof timer.unref === 'function') timer.unref();
  return id;
}

function markTiming(id, phase, extra = {}) {
  if (!id || !entries.has(id)) return;
  emit(id, phase, extra);
}

function finishTiming(id, extra = {}) {
  if (!id) return;
  markTiming(id, 'finish', extra);
  entries.delete(id);
}

const HIDE_SETTLE_MS = Math.max(0, Number(process.env.SL_HIDE_SETTLE_MS) || 160);

function waitHideSettle() {
  return new Promise((resolve) => setTimeout(resolve, HIDE_SETTLE_MS));
}

module.exports = { startTiming, markTiming, finishTiming, waitHideSettle, HIDE_SETTLE_MS };
