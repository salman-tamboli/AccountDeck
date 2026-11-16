// Checks that the packed app (app.asar) holds exactly the reviewed source files, byte for byte,
// and nothing else. Usage: node tools/verify-asar.js <path to app.asar>
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-'));
asar.extractAll(process.argv[2], out);

const walk = (dir, base = dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, acc); else acc.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return acc;
};
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const expected = [...walk(path.join(root, 'src')).map(f => 'src/' + f), ...walk(path.join(root, 'assets')).map(f => 'assets/' + f)];
const packed = walk(out).filter(f => f !== 'package.json');
const problems = [];
for (const f of expected) {
  if (!packed.includes(f)) problems.push(`missing from the app: ${f}`);
  else if (sha(path.join(root, f)) !== sha(path.join(out, f))) problems.push(`differs from the source: ${f}`);
}
for (const f of packed) if (!expected.includes(f)) problems.push(`not in the source: ${f}`);

const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
const src = require(path.join(root, 'package.json'));
if (pkg.main !== src.main || pkg.name !== src.name || pkg.version !== src.version) problems.push('package.json: name, version or main differs');
if (pkg.dependencies && Object.keys(pkg.dependencies).length) problems.push('package.json: unexpected runtime dependencies');

fs.rmSync(out, { recursive: true, force: true });
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(`Packed app matches the source: ${expected.length} files, nothing extra.`);
