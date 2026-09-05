// The @tari-project npm packages ship bundler-style ESM (extensionless relative
// imports) which plain Node.js cannot resolve. This script rewrites those
// imports to include the explicit file extension, and is run automatically by
// `npm install` (see package.json "postinstall").
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
if (!roots.length) roots.push(path.resolve(import.meta.dirname, '../node_modules/@tari-project'));

const IMPORT_RE = /(from\s+["'])(\.[^"']+)(["'])/g;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.js')) out.push(full);
  }
  return out;
}

let changed = 0;
for (const root of roots) {
  if (!statSync(root, { throwIfNoParent: false })?.isDirectory()) continue;
  for (const file of walk(root)) {
    const src = readFileSync(file, 'utf8');
    const next = src.replace(IMPORT_RE, (all, pre, spec, post) => {
      if (spec.endsWith('.js') || spec.endsWith('.json') || spec.endsWith('.node')) return all;
      const candidates = [
        path.join(path.dirname(file), spec + '.js'),
        path.join(path.dirname(file), spec, 'index.js'),
      ];
      const hit = candidates.find((c) => {
        try { return statSync(c).isFile(); } catch { return false; }
      });
      if (!hit) return all;
      const resolved = path.relative(path.dirname(file), hit);
      return pre + './' + resolved.replaceAll('\\', '/') + post;
    });
    if (next !== src) {
      writeFileSync(file, next);
      changed += 1;
    }
  }
}
console.log(`[patch-packages] patched ${changed} file(s)`);