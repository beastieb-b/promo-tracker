// Which server build is running: shown under the logo on every page and in
// Settings → About, with a "Restart to update" prompt when the code on disk
// is newer than what's running (e.g. after a git pull without a restart).

import { state, subscribe } from './state.js';
import { $, setText, show, formatDateTime } from './util.js';

const short = (b) => (b && b.version ? `v${b.version}` : '—');

function render() {
  const b = state.stats?.server || state.meta?.build;
  if (!b) return;
  const build = b.commit ? `${b.commit}${b.modified ? ' (modified)' : ''}` : 'not a git checkout';
  const built = b.commitDate ? formatDateTime(b.commitDate, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const since = formatDateTime(b.startedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const side = $('sidebar-version');
  if (side) {
    setText(side, `${short(b)}${b.commit ? ` · ${b.commit}` : ''}`);
    side.title = `Running ${short(b)}, build ${build}${built ? ` from ${built}` : ''} — started ${since}`;
  }
  setText('about-version', short(b));
  setText('about-build', built ? `${build} · ${built}` : build);
  setText('about-started', since);

  const disk = b.disk || {};
  const waiting = !!b.restartNeeded;
  const newer = `${disk.version ? `v${disk.version}` : 'newer code'}${disk.commit ? ` (${disk.commit})` : ''}`;
  const chip = $('update-chip');
  if (chip) {
    show(chip, waiting);
    chip.title = waiting ? `${newer} is installed but the server is still running ${short(b)}${b.commit ? ` (${b.commit})` : ''}. Restart to load it.` : '';
  }
  show('about-update', waiting);
  if (waiting) setText('about-update-desc', `${newer} is installed, but the server is still running ${short(b)}${b.commit ? ` (${b.commit})` : ''}. Restart to load it.`);
}

export function initVersion() {
  subscribe('stats', render);
  subscribe('meta', render);
}
