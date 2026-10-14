// Toast notifications (stacked, with an optional action button) and the
// delayed-commit "Undo" pattern used for deletes.

const MAX_TOASTS = 3;
const actions = new Map();   // toast id -> action callback
let nextId = 0;
let region = null;

function getRegion() {
  if (region) return region;
  region = document.getElementById('toast-region');
  // One delegated listener for every toast's action button.
  region?.addEventListener('click', e => {
    const btn = e.target.closest('.toast-action');
    if (!btn) return;
    const toast = btn.closest('.toast');
    const fn = actions.get(toast?.dataset.toastId);
    dismiss(toast);
    fn?.();
  });
  return region;
}

function dismiss(el) {
  if (!el || el.dataset.closing) return;
  el.dataset.closing = '1';
  clearTimeout(Number(el.dataset.timer));
  actions.delete(el.dataset.toastId);
  el.classList.remove('show');
  setTimeout(() => el.remove(), 250);
}

/**
 * showToast(message, type?, { actionLabel, onAction, duration })
 * type: 'info' | 'success' | 'error'. Returns { close }.
 */
export function showToast(message, type = 'info', { actionLabel, onAction, duration } = {}) {
  const root = getRegion();
  if (!root) return { close() {} };
  const id = String(++nextId);
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.dataset.toastId = id;

  const text = document.createElement('span');
  text.className = 'toast-msg';
  text.textContent = message;
  el.append(text);

  if (actionLabel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = actionLabel;
    el.append(btn);
    if (onAction) actions.set(id, onAction);
  }

  root.append(el);
  // Too many on screen: drop the oldest plain toasts first so an Undo stays reachable.
  const open = () => [...root.querySelectorAll('.toast:not([data-closing])')].filter(t => t !== el);
  let excess = open().length + 1 - MAX_TOASTS;
  for (const old of open()) if (excess > 0 && !old.querySelector('.toast-action')) { dismiss(old); excess--; }
  for (const old of open()) if (excess > 0) { dismiss(old); excess--; }

  requestAnimationFrame(() => el.classList.add('show'));
  const ms = duration ?? (type === 'error' ? 6500 : 4000);
  el.dataset.timer = String(setTimeout(() => dismiss(el), ms));
  return { close: () => dismiss(el) };
}

export function clearToasts() {
  getRegion()?.querySelectorAll('.toast').forEach(dismiss);
}

/* ── Undo ────────────────────────────────────────────────────────────────── */

const pendingCommits = new Map();
let nextPending = 0;

/**
 * Hide-now, commit-later. The caller has already hidden the item; this shows
 * a toast with "Undo" for `delay` ms, then runs commit(). Undo runs onUndo()
 * and nothing is sent to the server.
 */
export function deferWithUndo({ message, onUndo, commit, delay = 5000 }) {
  const id = ++nextPending;
  const entry = { done: false, timer: 0, toast: null };

  entry.run = keepalive => {
    if (entry.done) return;
    entry.done = true;
    clearTimeout(entry.timer);
    pendingCommits.delete(id);
    entry.toast?.close();
    return commit({ keepalive });
  };

  entry.toast = showToast(message, 'info', {
    actionLabel: 'Undo',
    duration: delay,
    onAction: () => {
      if (entry.done) return;
      entry.done = true;
      clearTimeout(entry.timer);
      pendingCommits.delete(id);
      onUndo();
    },
  });
  entry.timer = setTimeout(() => entry.run(false), delay);
  pendingCommits.set(id, entry);
}

/** Commit everything still waiting (page is being closed). */
export function flushPendingUndos() {
  for (const entry of [...pendingCommits.values()]) entry.run(true);
}
