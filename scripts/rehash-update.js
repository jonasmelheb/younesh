'use strict';

// Après la signature, l'installateur n'est plus le même fichier : on recalcule sa taille et son empreinte
// dans latest.yml, sinon la mise à jour automatique refuserait le téléchargement.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dist = path.join(__dirname, '..', 'dist');
const yml = path.join(dist, 'latest.yml');
let text = fs.readFileSync(yml, 'utf8');
const file = /^path: (.+)$/m.exec(text)[1].trim();
const data = fs.readFileSync(path.join(dist, file));
const sha512 = crypto.createHash('sha512').update(data).digest('base64');
text = text.replace(/sha512: .+/g, `sha512: ${sha512}`).replace(/size: \d+/g, `size: ${data.length}`);
fs.writeFileSync(yml, text);
// L'ancienne carte des blocs ne correspond plus : sans elle, la mise à jour télécharge le fichier entier.
for (const f of fs.readdirSync(dist)) if (f.endsWith('.blockmap')) fs.rmSync(path.join(dist, f));
console.log(`latest.yml : ${file}, ${data.length} octets`);
