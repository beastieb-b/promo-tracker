// Point the app at a throwaway data directory (and away from any
// config.local.json) BEFORE any src/ module is loaded. node --test runs each
// test file in its own process, so every file gets a fresh directory.
const fs = require('fs');
const os = require('os');
const path = require('path');

function useTempData(settings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promo-test-'));
  process.env.PROMO_DATA_DIR = dir;
  process.env.PROMO_CONFIG = path.join(dir, 'no-config.json');
  delete process.env.HOST;
  delete process.env.PORT;
  delete process.env.PROMO_TOKEN;
  if (settings) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

module.exports = { useTempData };
