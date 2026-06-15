const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let ch = 0;

// 1. Remove toggleMeta from global scope (settings page JS)
const globalTM = 'function toggleMeta(card){ var id = card.getAttribute("data-meta"); if (!id) return;';
const globalTMEnd = '  content.innerHTML = hh;\n}';
if (c.includes(globalTM)) {
  // Find the function start and end
  const start = c.indexOf(globalTM);
  let end = c.indexOf(globalTMEnd, start);
  if (end > start) {
    end += globalTMEnd.length;
    c = c.substring(0, start) + c.substring(end);
    ch++; console.log('Global toggleMeta removed');
  }
}

// 2. Add toggleMeta inside ASSET_DETAIL_HTML script (before load())
const loadMarker = 'function load(){';
if (c.includes(loadMarker)) {
  const tmFn = `function toggleMeta(card){ var id = card.getAttribute("data-meta"); if (!id) return; var content = document.getElementById('mc-'+id); var title = card.querySelector('.card-title'); if (!content || !title) return; var isOpen = content.style.display !== 'none'; if (isOpen) { content.style.display = 'none'; title.textContent = title.textContent.replace(' ▾',' ▸'); return; } content.style.display = 'block'; title.textContent = title.textContent.replace(' ▸',' ▾'); if (content.dataset.loaded) return; content.dataset.loaded = '1'; var m = window._assetMeta || {}; var r = window._r || function(l,v){ return '<div class="info-row"><span class="info-label">'+l+'</span><span class="info-value">'+v+'</span></div>'; }; var hh = ''; if (id === 'scan') { var s = m.scan || {}; if (s.open_ports && s.open_ports.length) hh+=r('Portas abertas', s.open_ports.length); if (s.hostname) hh+=r('Hostname', s.hostname); if (s.ssh_banner) hh+=r('SSH Banner', s.ssh_banner); if (s.http_server) hh+=r('HTTP Server', s.http_server); if (s.http_title) hh+=r('HTTP Title', s.http_title); if (s.smtp_banner) hh+=r('SMTP Banner', s.smtp_banner); if (s.tls_subject) hh+=r('TLS Subject', s.tls_subject); if (s.tls_issuer) hh+=r('TLS Issuer', s.tls_issuer); if (s.tls_valid_from && s.tls_valid_to) hh+=r('TLS Validade', s.tls_valid_from+' → '+s.tls_valid_to); if (s.favicon_hash) hh+=r('Favicon Hash', s.favicon_hash); if (s.protocols_detected) { var p=Object.entries(s.protocols_detected).filter(function(e){return e[1];}).map(function(e){return e[0];}).join(', '); if(p) hh+=r('Protocolos', p); } if (!hh) hh='<p style=\"color:var(--muted);padding:.5rem 0\">Nenhum dado de scan.</p>'; } else if (id === 'inference') { var i = m.inference || {}; if (i.vendor) hh+=r('Fabricante inferido', i.vendor); if (i.product) hh+=r('Produto inferido', i.product); if (i.service) hh+=r('Serviço inferido', i.service); if (i.category) hh+=r('Categoria', i.category); if (i.evidence) hh+=r('Evidências', i.evidence.length); if (!hh) hh='<p style=\"color:var(--muted);padding:.5rem 0\">Nenhum dado de inferência.</p>'; } else if (id === 'snmp') { var sn = m.snmp || {}; if (sn.sysDescr) hh+=r('sysDescr', sn.sysDescr); if (sn.sysName) hh+=r('sysName', sn.sysName); if (sn.sysUptime) hh+=r('sysUptime', sn.sysUptime); if (sn.sysObjectID) hh+=r('sysObjectID', sn.sysObjectID); if (sn.sysLocation) hh+=r('sysLocation', sn.sysLocation); if (sn.sysContact) hh+=r('sysContact', sn.sysContact); if (sn.interfaces && sn.interfaces.length) hh+=r('Interfaces SNMP', sn.interfaces.length+' detectadas'); if (!hh) hh='<p style=\"color:var(--muted);padding:.5rem 0\">Nenhum dado SNMP.</p>'; } else if (id === 'banners') { var b = (m.scan && m.scan.port_banners) ? m.scan.port_banners : {}; var keys = Object.keys(b); if (keys.length > 0) { hh+='<table><thead><tr><th>Porta</th><th>Banner</th></tr></thead><tbody>'; keys.slice(0,10).forEach(function(k){ hh+='<tr><td><strong>'+k+'</strong></td><td style=\"font-size:.75rem;max-width:400px;word-break:break-all\">'+(b[k]||'—')+'</td></tr>'; }); hh+='</tbody></table>'; } else hh='<p style=\"color:var(--muted);padding:.5rem 0\">Nenhum banner detectado.</p>'; } else if (id === 'json') { hh = JSON.stringify(m, null, 2); } content.innerHTML = hh; }\n`;
  c = c.replace(loadMarker, tmFn + loadMarker);
  ch++; console.log('toggleMeta added to asset detail page');
}

fs.writeFileSync(file, c);
console.log('Total:', ch, 'DONE');
