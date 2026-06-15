const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// Replace the entire metadata section with lazy collapsible sections
const oldMeta = `  // Metadata as formatted sections
  const scan = m.scan || {};
  const inf = m.inference || {};
  const snmp = m.snmp || {};

  // SNMP section
  if (snmp.sysDescr || snmp.sysName || snmp.sysUptime || snmp.interfaces) {
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">SNMP</div>';
    if (snmp.sysDescr) h+=r('sysDescr', snmp.sysDescr);
    if (snmp.sysName) h+=r('sysName', snmp.sysName);
    if (snmp.sysUptime) h+=r('sysUptime', snmp.sysUptime);
    if (snmp.sysObjectID) h+=r('sysObjectID', snmp.sysObjectID);
    if (snmp.sysLocation) h+=r('sysLocation', snmp.sysLocation);
    if (snmp.sysContact) h+=r('sysContact', snmp.sysContact);
    if (snmp.interfaces && snmp.interfaces.length) h+=r('Interfaces SNMP', snmp.interfaces.length+' detectadas');
    h+='</div>';
  }

  // Scan details
  if (scan.open_ports || scan.port_banners || scan.ssh_banner || scan.http_server || scan.tls_subject) {
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Scan</div>';
    if (scan.open_ports && scan.open_ports.length) h+=r('Portas abertas', scan.open_ports.length);
    if (scan.hostname) h+=r('Hostname (scan)', scan.hostname);
    if (scan.ssh_banner) h+=r('SSH Banner', scan.ssh_banner);
    if (scan.http_server) h+=r('HTTP Server', scan.http_server);
    if (scan.http_title) h+=r('HTTP Title', scan.http_title);
    if (scan.smtp_banner) h+=r('SMTP Banner', scan.smtp_banner);
    if (scan.tls_subject) h+=r('TLS Subject', scan.tls_subject);
    if (scan.tls_issuer) h+=r('TLS Issuer', scan.tls_issuer);
    if (scan.tls_valid_from && scan.tls_valid_to) h+=r('TLS Validade', scan.tls_valid_from+' → '+scan.tls_valid_to);
    if (scan.favicon_hash) h+=r('Favicon Hash', scan.favicon_hash);
    if (scan.protocols_detected) {
      const protos = Object.entries(scan.protocols_detected).filter(([,v])=>v).map(([k])=>k).join(', ');
      if (protos) h+=r('Protocolos detectados', protos);
    }
    h+='</div>';
  }

  // Inference details
  if (inf.vendor || inf.product || inf.evidence) {
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Inferência</div>';
    if (inf.vendor) h+=r('Fabricante inferido', inf.vendor);
    if (inf.product) h+=r('Produto inferido', inf.product);
    if (inf.service) h+=r('Serviço inferido', inf.service);
    if (inf.category) h+=r('Categoria', inf.category);
    if (inf.evidence) h+=r('Evidências', inf.evidence.length);
    h+='</div>';
  }

  // Port banners summary
  if (scan.port_banners && Object.keys(scan.port_banners).length > 0) {
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Banners de Porta</div>';
    h+='<table><thead><tr><th>Porta</th><th>Banner</th></tr></thead><tbody>';
    Object.entries(scan.port_banners).slice(0,10).forEach(([port, banner]) => {
      h+='<tr><td><strong>'+port+'</strong></td><td style="font-size:.75rem;max-width:400px;word-break:break-all">'+(banner||'—')+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }

  // Raw JSON toggle (collapsible, hidden by default)
  h+='<details class="card" style="margin-top:1.5rem;cursor:pointer"><summary class="card-title" style="display:inline-block">JSON Completo</summary>';
  h+='<pre class="meta-json">'+JSON.stringify(m,null,2)+'</pre></details>';`;

const newLazyMeta = `  // Lazy metadata sections - all collapsed by default
  h+='<details class="card" style="margin-top:1.5rem;cursor:pointer" id="meta-scan"><summary class="card-title" style="display:inline-block;list-style:none">🔍 Scan</summary><div class="meta-content" id="mc-scan">Carregando...</div></details>';
  h+='<details class="card" style="margin-top:.5rem;cursor:pointer" id="meta-inference"><summary class="card-title" style="display:inline-block;list-style:none">🧠 Inferência</summary><div class="meta-content" id="mc-inference">Carregando...</div></details>';
  h+='<details class="card" style="margin-top:.5rem;cursor:pointer" id="meta-snmp"><summary class="card-title" style="display:inline-block;list-style:none">📡 SNMP</summary><div class="meta-content" id="mc-snmp">Carregando...</div></details>';
  if (m.scan && m.scan.port_banners) h+='<details class="card" style="margin-top:.5rem;cursor:pointer" id="meta-banners"><summary class="card-title" style="display:inline-block;list-style:none">🏷 Banners de Porta</summary><div class="meta-content" id="mc-banners">Carregando...</div></details>';
  h+='<details class="card" style="margin-top:.5rem;cursor:pointer" id="meta-json"><summary class="card-title" style="display:inline-block;list-style:none">📋 JSON Completo</summary><pre class="meta-json" id="mc-json">Carregando...</pre></details>';

  // Lazy render on toggle - only build content when expanded
  const lazyMeta = function(id){
    if (document.getElementById('mc-'+id).dataset.loaded) return;
    document.getElementById('mc-'+id).dataset.loaded = '1';
    let hh = '';
    if (id === 'scan') {
      const s = m.scan || {};
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
      if (s.protocols_detected) { const p=Object.entries(s.protocols_detected).filter(([,v])=>v).map(([k])=>k).join(', '); if(p) hh+=r('Protocolos', p); }
      if (!hh) hh = '<p style="color:var(--muted);padding:.5rem 0">Nenhum dado de scan.</p>';
    } else if (id === 'inference') {
      const i = m.inference || {};
      if (i.vendor) hh+=r('Fabricante inferido', i.vendor);
      if (i.product) hh+=r('Produto inferido', i.product);
      if (i.service) hh+=r('Serviço inferido', i.service);
      if (i.category) hh+=r('Categoria', i.category);
      if (i.evidence) hh+=r('Evidências', i.evidence.length);
      if (!hh) hh = '<p style="color:var(--muted);padding:.5rem 0">Nenhum dado de inferência.</p>';
    } else if (id === 'snmp') {
      const s = m.snmp || {};
      if (s.sysDescr) hh+=r('sysDescr', s.sysDescr);
      if (s.sysName) hh+=r('sysName', s.sysName);
      if (s.sysUptime) hh+=r('sysUptime', s.sysUptime);
      if (s.sysObjectID) hh+=r('sysObjectID', s.sysObjectID);
      if (s.sysLocation) hh+=r('sysLocation', s.sysLocation);
      if (s.sysContact) hh+=r('sysContact', s.sysContact);
      if (s.interfaces && s.interfaces.length) hh+=r('Interfaces SNMP', s.interfaces.length+' detectadas');
      if (!hh) hh = '<p style="color:var(--muted);padding:.5rem 0">Nenhum dado SNMP. SNMP desabilitado ou sem resposta.</p>';
    } else if (id === 'banners') {
      const b = (m.scan && m.scan.port_banners) ? m.scan.port_banners : {};
      const keys = Object.keys(b);
      if (keys.length > 0) {
        hh+='<table><thead><tr><th>Porta</th><th>Banner</th></tr></thead><tbody>';
        keys.slice(0,10).forEach(k => { hh+='<tr><td><strong>'+k+'</strong></td><td style="font-size:.75rem;max-width:400px;word-break:break-all">'+(b[k]||'—')+'</td></tr>'; });
        hh+='</tbody></table>';
      } else { hh = '<p style="color:var(--muted);padding:.5rem 0">Nenhum banner detectado.</p>'; }
    } else if (id === 'json') {
      hh = JSON.stringify(m, null, 2);
    }
    document.getElementById('mc-'+id).innerHTML = hh;
  };
  // Attach toggle listeners
  ['scan','inference','snmp','banners','json'].forEach(function(id){
    const el = document.getElementById('meta-'+id);
    if (el) el.addEventListener('toggle', function(){ if (el.open) lazyMeta(id); });
  });`;

if (c.includes(oldMeta)) {
  c = c.replace(oldMeta, newLazyMeta);
  changes++;
  console.log('Lazy metadata sections added');
} else {
  console.log('old pattern not found, searching...');
  if (c.includes('Metadata as formatted')) console.log('  found partial');
  else console.log('  not found at all');
}

fs.writeFileSync(file, c);
console.log('Total:', changes, 'DONE');
