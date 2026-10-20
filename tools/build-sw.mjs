// Aggiorna web/sw.js prima della pubblicazione: elenco completo dei file da tenere
// offline (così un file nuovo non viene mai dimenticato) e versione della cache.
// Uso:  node tools/build-sw.mjs [versione]     (senza versione la lascia invariata)
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));
const SKIP = new Set(['sw.js', '.nojekyll']);
const SKIP_DIRS = ['screenshots/']; // servono solo al manifest per l'installazione

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [relative(WEB, p).split(sep).join('/')];
  });
}

const files = walk(WEB).filter((f) => !SKIP.has(f) && !SKIP_DIRS.some((d) => f.startsWith(d))).sort((a, b) => {
  const rank = (f) => (f === 'index.html' ? 0 : f.includes('/') ? 2 : 1);
  return rank(a) - rank(b) || a.localeCompare(b);
});
const list = ["    './',", ...files.map((f) => `    '${f}',`)].join('\n');

const swPath = join(WEB, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
sw = sw.replace(/const ASSETS = \[[\s\S]*?\n\];/, `const ASSETS = [\n${list}\n];`);
const version = process.argv[2];
if (version) sw = sw.replace(/^const VERSION = .*$/m, `const VERSION = 'fonogramma-${version}';`);
writeFileSync(swPath, sw);
console.log(`sw.js: ${files.length + 1} file in cache${version ? `, versione ${version}` : ''}`);
