// Writes public/third-party-notices.txt: the name, version, license and
// license text of every package the extension ships (production
// dependencies and everything they depend on). Run: npm run notices
// It reads only node_modules on this computer; nothing is downloaded.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
// One installed package directory per line; the first line is this project.
const dirs = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && path.resolve(l) !== root);

const seen = new Map();
for (const dir of dirs) {
  const pj = path.join(dir, 'package.json');
  if (!existsSync(pj)) continue;
  const { name, version } = JSON.parse(readFileSync(pj, 'utf8'));
  const key = `${name}@${version}`;
  if (!seen.has(key)) seen.set(key, { name, version, dir });
}

function licenseText(dir) {
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$|-)/i.test(f));
  return file ? readFileSync(path.join(dir, file), 'utf8').trim() : null;
}

const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const out = [
  'Review Pen includes the following open-source software.',
  'Each package keeps its own license, reproduced below.',
  '',
  `Packages: ${entries.length}`,
  '',
  'Notes on packages offered under a choice of licenses:',
  '- elkjs is used under the Eclipse Public License 2.0. Its source code is available at https://github.com/kieler/elkjs',
  '- DOMPurify is used under the Apache License 2.0.',
  '',
];
const summary = new Map();
for (const e of entries) {
  const pkg = JSON.parse(readFileSync(path.join(e.dir, 'package.json'), 'utf8'));
  const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? (pkg.licenses ?? []).map((l) => l.type).join(' OR ') ?? 'UNKNOWN';
  summary.set(license, (summary.get(license) ?? 0) + 1);
  out.push('='.repeat(78), `${e.name} ${e.version}`, `License: ${license || 'UNKNOWN'}`, pkg.homepage ? `Homepage: ${pkg.homepage}` : '', '');
  out.push(licenseText(e.dir) ?? `(No license file is included in this package. Its package.json states: ${license || 'UNKNOWN'}.)`, '');
}
writeFileSync(path.join(root, 'public', 'third-party-notices.txt'), out.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n') + '\n');
console.log(`Wrote ${entries.length} packages.`);
console.log([...summary.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${n.toString().padStart(4)}  ${l}`).join('\n'));
