const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// Step 1: Replace the lazy metadata section with simple onclick divs
const sectionMarker = '// Lazy metadata sections - all collapsed by default';
if (c.includes(sectionMarker)) {
  const idx = c.indexOf(sectionMarker);
  const endIdx = c.indexOf("document.getElementById('content').innerHTML = h;", idx);
  if (endIdx > idx) {
    const newSection = `// Lazy metadata sections - collapsed by default, render on click
  h+='<div class="card" style="margin-top:1.5rem;cursor:pointer" onclick="toggleMeta(this,\\'scan\\')"><div class="card-title">🔍 Scan ▸</div><div class="meta-content" id="mc-scan" style="display:none"></div></div>';
  h+='<div class="card" style="margin-top:.5rem;cursor:pointer" onclick="toggleMeta(this,\\'inference\\')"><div class="card-title">🧠 Inferência ▸</div><div class="meta-content" id="mc-inference" style="display:none"></div></div>';
  h+='<div class="card" style="margin-top:.5rem;cursor:pointer" onclick="toggleMeta(this,\\'snmp\\')"><div class="card-title">📡 SNMP ▸</div><div class="meta-content" id="mc-snmp" style="display:none"></div></div>';
  if (m.scan && m.scan.port_banners) h+='<div class="card" style="margin-top:.5rem;cursor:pointer" onclick="toggleMeta(this,\\'banners\\')"><div class="card-title">🏷 Banners de Porta ▸</div><div class="meta-content" id="mc-banners" style="display:none"></div></div>';
  h+='<div class="card" style="margin-top:.5rem;cursor:pointer" onclick="toggleMeta(this,\\'json\\')"><div class="card-title">📋 JSON Completo ▸</div><pre class="meta-json" id="mc-json" style="display:none"></pre></div>';
  window._assetMeta = m;
  window._r = r;
  document.getElementById('content').innerHTML = h;`;
    c = c.substring(0, idx) + newSection + c.substring(endIdx + 52);
    changes++;
    console.log('Lazy metadata replaced with onclick divs');
  }
} else { console.log('Section marker not found'); }

// Step 2: Add toggleMeta function
const fnMarker = `function getHeaders(){return{'Content-Type':'application/json'};}`;
if (c.includes(fnMarker) && !c.includes('function toggleMeta')) {
  const fn = `
function toggleMeta(card, id){
  var content = document.getElementById('mc-'+id);
  var title = card.querySelector('.card-title');
  if (!content || !title) return;
  var isOpen = content.style.display !== 'none';
  if (isOpen) { content.style.display = 'none'; title.textContent = title.textContent.replace(' ▾',' ▸'); return; }
  content.style.display = 'block';
  title.textContent = title.textContent.replace(' ▸',' ▾');
  if (content.dataset.loaded) return;
  content.dataset.loaded = '1';
  var m = window._assetMeta || {};
  var r = window._r || function(l,v){ return '<div class="info-row"><span class="info-label">'+l+'</span><span class="info-value">'+v+'</span></div>'; };
  var hh = '';
  if (id === 'scan') {
    var s = m.scan || {};
    if (s.open_ports && s.open_ports.length) hh+=r('Portas abertas', s.open_ports.length);
    if (s.hostname) hh+=r('Hostname', s.hostname);
    if (s.ssh_banner) hh+=r('SSH Banner', s.ssh_banner);
    if (s.http_server) hh+=r('HTTP Server', s.http_server);
    if (s.http_title) hh+=r('HTTP Title', s.http_title);
    if (s.smtp_banner) hh+=r('SMTP Banner', s.smtp_banner);
    if (s.tls_subject) hh+=r('TLS Subject', s.tls_subject);
    if (s.tls_issuer) hh+=r('TLS Issuer', s.tls_issuer);
    if (s.tls_valid_from && s.tls_valid_to) hh+=r('TLS Validade', s.tls_valid_from+' → '+s.tls_valid_to);
    if (s.favicon_hash) hh+=r('Favicon Hash', s.favicon_hash);
    if (s.protocols_detected) { var p=Object.entries(s.protocols_detected).filter(function(e){return e[1];}).map(function(e){return e[0];}).join(', '); if(p) hh+=r('Protocolos', p); }
    if (!hh) hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum dado de scan.</p>';
  } else if (id === 'inference') {
    var i = m.inference || {};
    if (i.vendor) hh+=r('Fabricante inferido', i.vendor);
    if (i.product) hh+=r('Produto inferido', i.product);
    if (i.service) hh+=r('Serviço inferido', i.service);
    if (i.category) hh+=r('Categoria', i.category);
    if (i.evidence) hh+=r('Evidências', i.evidence.length);
    if (!hh) hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum dado de inferência.</p>';
  } else if (id === 'snmp') {
    var sn = m.snmp || {};
    if (sn.sysDescr) hh+=r('sysDescr', sn.sysDescr);
    if (sn.sysName) hh+=r('sysName', sn.sysName);
    if (sn.sysUptime) hh+=r('sysUptime', sn.sysUptime);
    if (sn.sysObjectID) hh+=r('sysObjectID', sn.sysObjectID);
    if (sn.sysLocation) hh+=r('sysLocation', sn.sysLocation);
    if (sn.sysContact) hh+=r('sysContact', sn.sysContact);
    if (sn.interfaces && sn.interfaces.length) hh+=r('Interfaces SNMP', sn.interfaces.length+' detectadas');
    if (!hh) hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum dado SNMP.</p>';
  } else if (id === 'banners') {
    var b = (m.scan && m.scan.port_banners) ? m.scan.port_banners : {};
    var keys = Object.keys(b);
    if (keys.length > 0) {
      hh+='<table><thead><tr><th>Porta</th><th>Banner</th></tr></thead><tbody>';
      keys.slice(0,10).forEach(function(k){ hh+='<tr><td><strong>'+k+'</strong></td><td style="font-size:.75rem;max-width:400px;word-break:break-all">'+(b[k]||'—')+'</td></tr>'; });
      hh+='</tbody></table>';
    } else hh='<p style="color:var(--muted);padding:.5rem 0">Nenhum banner detectado.</p>';
  } else if (id === 'json') {
    hh = JSON.stringify(m, null, 2);
  }
  content.innerHTML = hh;
}`;
  c = c.replace(fnMarker, fn + fnMarker);
  changes++;
  console.log('toggleMeta function added');
}

fs.writeFileSync(file, c);
console.log('Total:', changes, 'DONE');
