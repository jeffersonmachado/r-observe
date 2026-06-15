const fs = require('fs');
let c = fs.readFileSync('/app/src/index.js', 'utf8');

const old = `  children.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c instanceof Node) el.appendChild(c); });`;
const nxt = `  (function walk(arr){ arr.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c instanceof Node) el.appendChild(c); else if (Array.isArray(c)) walk(c); }); })(children);`;

if (c.includes(old)) {
  c = c.replace(old, nxt);
  fs.writeFileSync('/app/src/index.js', c);
  console.log('PATCHED - h() array recursion');
} else {
  console.log('pattern not found');
}
