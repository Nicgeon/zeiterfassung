// Vergleicht zwei Stil-Schnappschüsse (siehe stil-schnappschuss.js). Aufruf: node stil-vergleich.js vorher.json nachher.json
const fs = require('fs');
const a = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const b = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let diffs = 0;
const byProp = new Map();
for (const key of Object.keys(a)) {
  const A = a[key];
  const B = b[key];
  if (!B) { console.log('fehlt nachher:', key); diffs++; continue; }
  if (A.length !== B.length) { console.log(`${key}: Elementzahl ${A.length} -> ${B.length}`); diffs++; continue; }
  for (let i = 0; i < A.length; i++) {
    const [pa, ta, sa, psa, ra] = A[i];
    const [pb, tb, sb, psb, rb] = B[i];
    if (pa !== pb || ta !== tb) { console.log(`${key}: Struktur ${pa} ${ta} -> ${pb} ${tb}`); diffs++; break; }
    if (sa !== sb || psa !== psb || ra !== rb) {
      diffs++;
      const xa = sa.split('|');
      const xb = sb.split('|');
      const changed = xa.map((v, j) => (v !== xb[j] ? j : -1)).filter((j) => j >= 0);
      const label = changed.length ? changed.join(',') : (psa !== psb ? 'pseudo' : 'rect');
      byProp.set(label, (byProp.get(label) || 0) + 1);
      if (diffs <= 40) console.log(`${key} ${ta}: ${changed.length ? changed.map((j) => `[${j}] ${xa[j]} -> ${xb[j]}`).join('; ') : psa !== psb ? `pseudo ${psa} -> ${psb}` : `rect ${ra} -> ${rb}`}`);
    }
  }
}
console.log(diffs ? `Unterschiede: ${diffs}` : 'Keine Unterschiede.', [...byProp].slice(0, 20));
process.exit(diffs ? 1 : 0);
