// Hash routing (#overview, #queue, #results, #log, #settings) and the mobile drawer.

import { publish } from './state.js';
import { onAction } from './actions.js';

export const SECTIONS = ['overview', 'queue', 'results', 'log', 'settings'];

let current = null;
let pendingFocus = null;

export const currentSection = () => current;
export const isVisible = section => current === section;

function parseHash() {
  let h = location.hash.replace(/^#/, '');
  try { h = decodeURIComponent(h); } catch { /* keep raw */ }
  return SECTIONS.includes(h) ? h : null;
}

function showSection(section, { userNav = false } = {}) {
  if (!section) {
    section = 'overview';
    // Unknown hash: normalise the URL so Back/Forward stay meaningful.
    if (location.hash && location.hash !== '#') {
      history.replaceState(history.state, '', `${location.pathname}${location.search}#overview`);
    }
  }
  const changed = section !== current;
  current = section;

  for (const id of SECTIONS) {
    document.getElementById(`section-${id}`)?.classList.toggle('active', id === section);
  }
  document.querySelectorAll('.nav-item[data-section]').forEach(link => {
    const active = link.dataset.section === section;
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  closeSidebar();

  if (changed && userNav) {
    const main = document.getElementById('main');
    if (main) main.scrollTop = 0;
  }
  publish('section', section);

  if (pendingFocus) {
    const target = document.querySelector(pendingFocus);
    pendingFocus = null;
    if (target) {
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: 'center' });
      return;
    }
  }
  if (changed && userNav) {
    document.querySelector(`#section-${section} h1`)?.focus({ preventScroll: true });
  }
}

/** Navigate to a section, optionally focusing an element once it is visible. */
export function go(section, { focus } = {}) {
  pendingFocus = focus || null;
  if (location.hash === `#${section}`) showSection(section, { userNav: true });
  else location.hash = section;   // hashchange -> showSection
}

/* ── Mobile drawer ───────────────────────────────────────────────────────── */

function setSidebar(open) {
  document.getElementById('sidebar')?.classList.toggle('open', open);
  document.getElementById('sidebar-backdrop')?.classList.toggle('open', open);
  document.getElementById('nav-toggle')?.setAttribute('aria-expanded', String(open));
}

export function closeSidebar() { setSidebar(false); }

export function initRouter() {
  window.addEventListener('hashchange', () => showSection(parseHash(), { userNav: true }));

  onAction('click', 'toggle-sidebar', () => {
    const open = !document.getElementById('sidebar')?.classList.contains('open');
    setSidebar(open);
    if (open) document.querySelector('.sidebar .nav-item.active')?.focus();
  });
  onAction('click', 'close-sidebar', () => closeSidebar());

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && document.getElementById('sidebar')?.classList.contains('open')) {
      closeSidebar();
      document.getElementById('nav-toggle')?.focus();
    }
  });

  showSection(parseHash());
}
