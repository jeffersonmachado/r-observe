const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let ch = 0;

// renderDiscovery: add SNMP + discovery toggles
const old = `  document.getElementById('sld-grace').value=2;document.getElementById('sldv-grace').textContent='2 scans';
}`;
if (c.includes(old)) {
  c = c.replace(old, `  document.getElementById('sld-grace').value=2;document.getElementById('sldv-grace').textContent='2 scans';
  el.appendChild(h('div',{className:'field'},[h('div',{},toggle('snmp_discovery')),h('div',{className:'toggle-desc'},'Ativar descoberta SNMP (sysDescr, OS, interfaces)')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'SNMP Community'),h('input',{type:'text',id:'txt-snmp_community',value:'public',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));
  document.getElementById('tog-snmp_discovery').checked=false;
  el.appendChild(h('div',{className:'field'},[toggle('discovery_arp'),h('div',{className:'toggle-desc'},'Descoberta via ARP (rede local)')]));
  el.appendChild(h('div',{className:'field'},[toggle('discovery_docker'),h('div',{className:'toggle-desc'},'Descoberta de contêineres Docker')]));
  el.appendChild(h('div',{className:'field'},[toggle('discovery_cloud'),h('div',{className:'toggle-desc'},'Descoberta de recursos Cloud (AWS)')]));
  el.appendChild(h('div',{className:'field'},[toggle('discovery_passive'),h('div',{className:'toggle-desc'},'Listeners passivos (syslog, netflow, traps)')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Scans paralelos'),slider('scan_parallel',1,100,1,20,'')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Portas extras (separadas por vírgula)'),h('input',{type:'text',id:'txt-extra_ports',value:'',placeholder:'Ex: 8080,8443,9090',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));
  document.getElementById('tog-discovery_arp').checked=true;
  document.getElementById('tog-discovery_docker').checked=true;
  document.getElementById('tog-discovery_cloud').checked=false;
  document.getElementById('tog-discovery_passive').checked=true;
  document.getElementById('sld-scan_parallel').value=20;document.getElementById('sldv-scan_parallel').textContent='20';
}`);
  ch++; console.log('renderDiscovery expanded');
} else { console.log('renderDiscovery pattern not found'); }

// h() array recursion fix
if (c.includes("children.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c) el.appendChild(c); });")) {
  c = c.replace("children.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c) el.appendChild(c); });",
    "(function walk(arr){ arr.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c instanceof Node) el.appendChild(c); else if (Array.isArray(c)) walk(c); }); })(children);");
  ch++; console.log('h() fix');
}

// setSessionCookie fix
if (c.includes('setSessionCookie(req, res, result.token, expiresAt)')) {
  c = c.replace('setSessionCookie(req, res, result.token, expiresAt)', 'setSessionCookie(req, res, SESSION_COOKIE, result.token, expiresAt)');
  ch++; console.log('setSessionCookie fix');
}

// authenticateRequest fix
if (c.includes('const auth = await authenticateRequest(req);')) {
  c = c.replace('const auth = await authenticateRequest(req);', 'const auth = await authenticateRequest(req, db, SESSION_COOKIE);');
  ch++; console.log('authenticateRequest fix');
}

// async handler fix for system/settings
if (c.includes("app.post(`${BASE}/system/settings`, requireAuth, requireAdmin, (req, res) => {")) {
  c = c.replace("app.post(`${BASE}/system/settings`, requireAuth, requireAdmin, (req, res) => {",
    "app.post(`${BASE}/system/settings`, requireAuth, requireAdmin, async (req, res) => {");
  ch++; console.log('async handler fix');
}

fs.writeFileSync(file, c);
console.log('Total:', ch, 'DONE');
