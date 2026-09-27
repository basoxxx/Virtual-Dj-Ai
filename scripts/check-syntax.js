// Controllo di sintassi di tutti i sorgenti JavaScript (main CJS e renderer ESM).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const roots = ['src', 'scripts', 'test'];
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.name.endsWith('.js')) files.push(full);
  }
};
roots.forEach((r) => fs.existsSync(r) && walk(r));
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    console.error(`✗ ${f}\n${err.stderr}`);
  }
}
console.log(`${files.length - failed}/${files.length} file OK`);
process.exit(failed ? 1 : 0);
