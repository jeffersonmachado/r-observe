const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let ch = 0;

// Fix onclick attributes: replace inline args with data-meta
const onclickPatterns = [
  { s: 'scan', pattern: "toggleMeta(this,\\'scan\\')" },
  { s: 'inference', pattern: "toggleMeta(this,\\'inference\\')" },
  { s: 'snmp', pattern: "toggleMeta(this,\\'snmp\\')" },
  { s: 'banners', pattern: "toggleMeta(this,\\'banners\\')" },
  { s: 'json', pattern: "toggleMeta(this,\\'json\\')" },
];

onclickPatterns.forEach(({s, pattern}) => {
  if (c.includes(pattern)) {
    c = c.replaceAll(pattern, `toggleMeta(this)" data-meta="${s}"`);
    ch++;
  }
});
console.log('Fixed', ch, 'onclick attributes');

// Update toggleMeta to use data-meta
if (c.includes('function toggleMeta(card, id){')) {
  c = c.replace('function toggleMeta(card, id){', 'function toggleMeta(card){ var id = card.getAttribute("data-meta"); if (!id) return;');
  ch++;
  console.log('toggleMeta signature updated');
}

fs.writeFileSync(file, c);
console.log('DONE');
