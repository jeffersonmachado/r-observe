const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// Replace the metadata JSON dump with formatted data
const oldJson = `  h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Metadata (JSON)</div>';
  h+='<pre class="meta-json">'+JSON.stringify(m,null,2)+'</pre></div>';`;

const newMeta = `  // Metadata as formatted sections
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

if (c.includes(oldJson)) {
  c = c.replace(oldJson, newMeta);
  changes++;
  console.log('Metadata formatted cards added');
} else {
  console.log('old pattern not found');
}

fs.writeFileSync(file, c);
console.log('Total:', changes, 'DONE');
