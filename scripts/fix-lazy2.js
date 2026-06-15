const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
const lines = fs.readFileSync(file, 'utf8').split('\n');

let startLine = -1, endLine = -1;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('// Lazy metadata sections - all collapsed by default')) startLine = i;
  if (startLine >= 0 && lines[i].includes("document.getElementById('content').innerHTML=h;")) { endLine = i; break; }
}
console.log('Replace lines', startLine+1, 'to', endLine+1);

const newLines = [
  '// Lazy metadata sections - collapsed by default, render on click',
  "  h+='<div class=\"card\" style=\"margin-top:1.5rem;cursor:pointer\" onclick=\"toggleMeta(this,\\'scan\\')\"><div class=\"card-title\">🔍 Scan ▸</div><div class=\"meta-content\" id=\"mc-scan\" style=\"display:none\"></div></div>';",
  "  h+='<div class=\"card\" style=\"margin-top:.5rem;cursor:pointer\" onclick=\"toggleMeta(this,\\'inference\\')\"><div class=\"card-title\">🧠 Inferência ▸</div><div class=\"meta-content\" id=\"mc-inference\" style=\"display:none\"></div></div>';",
  "  h+='<div class=\"card\" style=\"margin-top:.5rem;cursor:pointer\" onclick=\"toggleMeta(this,\\'snmp\\')\"><div class=\"card-title\">📡 SNMP ▸</div><div class=\"meta-content\" id=\"mc-snmp\" style=\"display:none\"></div></div>';",
  "  if (m.scan && m.scan.port_banners) h+='<div class=\"card\" style=\"margin-top:.5rem;cursor:pointer\" onclick=\"toggleMeta(this,\\'banners\\')\"><div class=\"card-title\">🏷 Banners de Porta ▸</div><div class=\"meta-content\" id=\"mc-banners\" style=\"display:none\"></div></div>';",
  "  h+='<div class=\"card\" style=\"margin-top:.5rem;cursor:pointer\" onclick=\"toggleMeta(this,\\'json\\')\"><div class=\"card-title\">📋 JSON Completo ▸</div><pre class=\"meta-json\" id=\"mc-json\" style=\"display:none\"></pre></div>';",
  '  window._assetMeta = m;',
  '  window._r = r;',
  "  document.getElementById('content').innerHTML=h;"
];

lines.splice(startLine, endLine - startLine + 1, ...newLines);
fs.writeFileSync(file, lines.join('\n'));
console.log('DONE');
