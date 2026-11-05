'use strict';

// Refait les icônes depuis les SVG (il faut Inkscape) : npm run icons.
// En dessous de 64 px, le dessin complet devient flou : icon-small.svg ne garde que le Y.
// Un dossier en argument reçoit aussi les PNG, pour la version Java.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const build = path.join(__dirname, '..', 'build');
const render = (svg, size, out) => execFileSync('inkscape', [path.join(build, svg), '--export-type=png', `--export-filename=${out}`, `--export-width=${size}`, `--export-height=${size}`], { stdio: 'ignore' });

const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'younesh-icons-'));
const pngs = sizes.map((size) => {
  const out = path.join(dir, `icon-${size}.png`);
  render(size < 64 ? 'icon-small.svg' : 'icon.svg', size, out);
  return { size, out, data: fs.readFileSync(out) };
});

// Un .ico, c'est un petit index suivi des PNG.
const header = Buffer.alloc(6 + 16 * pngs.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
let offset = header.length;
pngs.forEach(({ size, data }, i) => {
  const at = 6 + 16 * i;
  header[at] = size === 256 ? 0 : size;
  header[at + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, at + 4);
  header.writeUInt16LE(32, at + 6);
  header.writeUInt32LE(data.length, at + 8);
  header.writeUInt32LE(offset, at + 12);
  offset += data.length;
});
fs.writeFileSync(path.join(build, 'icon.ico'), Buffer.concat([header, ...pngs.map((p) => p.data)]));
render('icon.svg', 1024, path.join(build, 'icon.png'));

const java = process.argv[2];
if (java) {
  for (const { size, out } of pngs) fs.copyFileSync(out, path.join(java, `icon-${size}.png`));
  render('icon.svg', 512, path.join(java, 'icon.png'));
}
fs.rmSync(dir, { recursive: true });
