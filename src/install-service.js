#!/usr/bin/env node
// Installs a launchd service so the daemon auto-starts on login (Mac only).
// Run: node src/install-service.js [--uninstall]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const cfg = require('./config');

const APP_DIR = cfg.APP_DIR;
const LABEL = cfg.SERVICE_LABEL;
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const NODE_PATH = execSync('which node').toString().trim();
const nodeVersion = execSync(`"${NODE_PATH}" -e "process.stdout.write(process.versions.node)"`).toString().trim();
const [nodeMajor, nodeMinor, nodePatch] = nodeVersion.split('.').map(Number);

if (!(nodeMajor > 20 || (nodeMajor === 20 && (nodeMinor > 18 || (nodeMinor === 18 && nodePatch >= 1))))) {
  console.error(`Node.js 20.18.1 or newer is required. Found v${nodeVersion} at ${NODE_PATH}.`);
  process.exit(1);
}

const uninstall = process.argv.includes('--uninstall');

if (uninstall) {
  try {
    execSync(`launchctl unload "${PLIST_PATH}"`, { stdio: 'ignore' });
  } catch {}
  if (fs.existsSync(PLIST_PATH)) {
    fs.unlinkSync(PLIST_PATH);
    console.log('✅ Service uninstalled.');
  } else {
    console.log('ℹ️  Service was not installed.');
  }
  process.exit(0);
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_PATH}</string>
    <string>${path.join(APP_DIR, 'src', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${APP_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(cfg.DATA_DIR, 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(cfg.DATA_DIR, 'daemon-error.log')}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}</string>
  </dict>
</dict>
</plist>`;

fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
fs.mkdirSync(cfg.DATA_DIR, { recursive: true });
fs.writeFileSync(PLIST_PATH, plist);

try {
  execSync(`launchctl unload "${PLIST_PATH}" 2>/dev/null; launchctl load "${PLIST_PATH}"`);
  console.log('✅ Service installed and started.');
  console.log(`   Plist: ${PLIST_PATH}`);
  console.log(`   Dashboard: http://localhost:${cfg.DASHBOARD_PORT}`);
  console.log(`   Logs: ${path.join(cfg.DATA_DIR, 'daemon.log')}`);
  console.log('\n   To uninstall: node src/install-service.js --uninstall');
} catch (err) {
  console.error('⚠️  Service installed but launchctl failed:', err.message);
  console.log('   Try running: launchctl load "' + PLIST_PATH + '"');
}
