const fs = require('fs');

// Write a file atomically: write to a temp file, then rename over the target.
// rename() is atomic on the same filesystem (POSIX), so a reader/crash never
// sees a half-written or truncated file — it sees either the old or new
// contents. Prevents silent corruption of the state files (catalog, queue,
// processed, settings) when a write races with a crash or machine sleep.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

module.exports = { writeFileAtomic };
