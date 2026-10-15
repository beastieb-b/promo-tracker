// Which build is running, and whether the code on disk has moved on since it
// started (a `git pull` or update without a restart).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cfg = require('./config');

function packageVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(cfg.APP_DIR, 'package.json'), 'utf8')).version || null; }
  catch { return null; }
}

// The checked-out commit (short hash + date), or nulls when this isn't a git
// checkout (e.g. a downloaded zip). `modified` = tracked files were edited.
function gitInfo() {
  const git = (...args) => execFileSync('git', ['-C', cfg.APP_DIR, ...args],
    { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    const [commit, commitDate] = git('log', '-1', '--format=%h %cI').split(' ');
    const modified = git('status', '--porcelain', '--untracked-files=no') !== '';
    return { commit, commitDate, modified };
  } catch {
    return { commit: null, commitDate: null, modified: false };
  }
}

const running = { version: packageVersion(), ...gitInfo(), startedAt: new Date().toISOString() };

let diskCache = { at: 0, value: null };
function onDisk() {
  if (!diskCache.value || Date.now() - diskCache.at > 60000) {
    diskCache = { at: Date.now(), value: { version: packageVersion(), commit: gitInfo().commit } };
  }
  return diskCache.value;
}

function info() {
  const disk = onDisk();
  const restartNeeded = (disk.version && disk.version !== running.version)
    || (!!disk.commit && !!running.commit && disk.commit !== running.commit);
  return { ...running, restartNeeded, disk };
}

// "v2.1.0 (c9ac9b0)" for logs and the CLI.
function label() {
  return `v${running.version || '?'}${running.commit ? ` (${running.commit}${running.modified ? ', modified' : ''})` : ''}`;
}

module.exports = { info, label };
