const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// ═══════════════════════════════════════════════════════════════════
// Replace the ENTIRE Asset Detail endpoint with enriched version
// ═══════════════════════════════════════════════════════════════════
const oldEndpoint = `app.get(\`\${BASE}/assets/:id\`, requireAuth, async (req, res) => {
  try {
    const pool = require('./db').createDbClient(process.env);
    const asset = await pool.query(
      \`SELECT id, asset_name, display_name, asset_type, vendor, product, os_hint, 
              primary_ip, hostname, lifecycle_state, criticality, confidence,
              metadata, first_seen_at, last_seen_at, created_at, updated_at
       FROM observe_assets
       WHERE id = \$1::uuid AND tenant_id = 'default'\`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!asset.rows.length) { await pool.end().catch(()=>{}); return res.status(404).json({ error: 'Ativo não encontrado' }); }
    const services = await pool.query(
      \`SELECT service_name, protocol, port, status, fingerprint, first_seen_at, last_seen_at
       FROM observe_asset_services
       WHERE asset_id = \$1::uuid AND tenant_id = 'default'
       ORDER BY port\`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    await pool.end().catch(() => {});
    res.json({ asset: asset.rows[0], services: services.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});`;

const newEndpoint = `app.get(\`\${BASE}/assets/:id\`, requireAuth, async (req, res) => {
  try {
    const pool = require('./db').createDbClient(process.env);
    const asset = await pool.query(
      \`SELECT id, asset_name, display_name, asset_type, vendor, product, os_hint, 
              primary_ip, hostname, lifecycle_state, criticality, confidence,
              metadata, first_seen_at, last_seen_at, created_at, updated_at
       FROM observe_assets
       WHERE id = \$1::uuid AND tenant_id = 'default'\`,
      [req.params.id]
    ).catch(() => ({ rows: [] }));
    if (!asset.rows.length) { await pool.end().catch(()=>{}); return res.status(404).json({ error: 'Ativo não encontrado' }); }
    
    const [services, incidents, changes, interfaces] = await Promise.all([
      pool.query(
        \`SELECT service_name, protocol, port, status, fingerprint, first_seen_at, last_seen_at
         FROM observe_asset_services
         WHERE asset_id = \$1::uuid AND tenant_id = 'default'
         ORDER BY port\`,
        [req.params.id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        \`SELECT i.id, i.title, i.severity, i.status, i.ai_summary, i.ai_suggestion, i.created_at
         FROM observe_incidents i
         WHERE i.host_id = \$1::uuid
         ORDER BY i.created_at DESC LIMIT 20\`,
        [req.params.id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        \`SELECT change_type, field_name, old_value, new_value, changed_at
         FROM observe_asset_changes
         WHERE asset_id = \$1::uuid AND tenant_id = 'default'
         ORDER BY changed_at DESC LIMIT 30\`,
        [req.params.id]
      ).catch(() => ({ rows: [] })),
      pool.query(
        \`SELECT iface_name, iface_type, mac_address, ip_addresses, speed_mbps, status
         FROM observe_asset_interfaces
         WHERE asset_id = \$1::uuid AND tenant_id = 'default'
         ORDER BY iface_name\`,
        [req.params.id]
      ).catch(() => ({ rows: [] }))
    ]);
    await pool.end().catch(() => {});
    
    // Enrich services with IANA port names + fingerprint labels
    const IANA = {20:'FTP-data',21:'FTP',22:'SSH',23:'Telnet',25:'SMTP',53:'DNS',67:'DHCP',68:'DHCP',80:'HTTP',110:'POP3',123:'NTP',143:'IMAP',161:'SNMP',162:'SNMP-trap',389:'LDAP',443:'HTTPS',445:'SMB',465:'SMTPS',514:'Syslog',587:'SMTP-submission',636:'LDAPS',873:'Rsync',993:'IMAPS',995:'POP3S',1433:'MSSQL',1521:'Oracle',2049:'NFS',2181:'ZooKeeper',2375:'Docker',2376:'Docker-TLS',3000:'Grafana/Node',3306:'MySQL',3389:'RDP',4000:'Jupyter/API',4369:'Erlang',5000:'API/Registry',5038:'Asterisk-AMI',5044:'Logstash-Beats',5353:'mDNS',5432:'PostgreSQL',5433:'PostgreSQL',5555:'API/Dev',5665:'Icinga2-API',5672:'RabbitMQ',6379:'Redis',6443:'K8s-API',8000:'HTTP-alt',8080:'HTTP-proxy',8443:'HTTPS-alt',9000:'MinIO/API',9090:'Prometheus',9092:'Kafka',9100:'NodeExporter',9200:'Elasticsearch',9300:'Elasticsearch-node',10050:'Zabbix',11211:'Memcached',27017:'MongoDB'};
    const enrichedServices = (services.rows || []).map(s => {
      let name = s.service_name;
      let banner = '';
      let productHint = '';
      if (s.fingerprint && typeof s.fingerprint === 'object') {
        const f = s.fingerprint;
        if (f.product_hint) productHint = f.product_hint;
        if (f.banner) banner = f.banner;
        if (f.technology && !productHint) productHint = f.technology;
      }
      // Resolve name: fingerprint > IANA > existing
      if (productHint && name.startsWith('port-')) name = productHint;
      else if (name.startsWith('port-') && IANA[s.port]) name = IANA[s.port];
      else if (name.startsWith('port-')) name = s.protocol + '/' + s.port;
      return { ...s, display_name: name, banner, product_hint: productHint };
    });
    
    res.json({ 
      asset: asset.rows[0], 
      services: enrichedServices,
      incidents: incidents.rows || [],
      changes: changes.rows || [],
      interfaces: interfaces.rows || []
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});`;

if (c.includes(oldEndpoint)) {
  c = c.replace(oldEndpoint, newEndpoint);
  changes++;
  console.log('[1] Asset Detail API enriched');
} else {
  console.log('[1] Endpoint not found - searching...');
  if (c.includes('assets/:id')) console.log('  assets/:id found but pattern mismatch');
}

// ═══════════════════════════════════════════════════════════════════
// Update ASSET_DETAIL_HTML: add incidents, interfaces, enriched services
// ═══════════════════════════════════════════════════════════════════
const oldHtml = `function render(a,svc){`;
const newHtml = `function render(a,svc,inc,chg,ifaces){`;
if (c.includes(oldHtml) && !c.includes('inc,chg,ifaces')) {
  c = c.replace(oldHtml, newHtml);
  changes++;
  console.log('[2] render signature updated');
}

// Update the load function to pass all data
const oldLoad = `fetch('/observe/api/assets/'+ASSET_ID,{headers:{'Accept':'application/json'}})
    .then(r=>r.ok?r.json():Promise.reject('HTTP '+r.status))
    .then(d=>render(d.asset,d.services))`;
const newLoad = `fetch('/observe/api/assets/'+ASSET_ID,{headers:{'Accept':'application/json'}})
    .then(r=>r.ok?r.json():Promise.reject('HTTP '+r.status))
    .then(d=>render(d.asset,d.services,d.incidents||[],d.changes||[],d.interfaces||[]))`;
if (c.includes(oldLoad) && !c.includes('d.incidents')) {
  c = c.replace(oldLoad, newLoad);
  changes++;
  console.log('[3] load() updated to pass all data');
}

// Add incidents section after services card
const oldSvcEnd = `h+='</div>';`;
const newSvcEnd = `h+='</div>';
  // Incidents / AI
  if(inc.length>0){
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Incidentes & IA ('+inc.length+')</div>';
    h+='<table><thead><tr><th>Incidente</th><th>Gravidade</th><th>Status</th><th>Resumo IA</th></tr></thead><tbody>';
    inc.forEach(i=>{
      const sevMap={critical:'🔴',warning:'🟡',info:'🔵',error:'🔴'};
      const sev=sevMap[i.severity]||'⚪';
      h+='<tr><td><strong>'+i.title+'</strong></td><td>'+sev+' '+i.severity+'</td><td>'+i.status+'</td><td style="font-size:.8rem">'+(i.ai_summary||'—')+'</td></tr>';
      if(i.ai_suggestion) h+='<tr><td colspan="4" style="font-size:.75rem;color:var(--accent)">💡 '+i.ai_suggestion+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }
  // Asset Changes
  if(chg.length>0){
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Histórico de Alterações ('+chg.length+')</div>';
    h+='<table><thead><tr><th>Tipo</th><th>Campo</th><th>De</th><th>Para</th><th>Data</th></tr></thead><tbody>';
    chg.slice(0,15).forEach(c=>{
      h+='<tr><td>'+c.change_type+'</td><td>'+(c.field_name||'—')+'</td><td style="font-size:.75rem">'+(c.old_value||'—')+'</td><td style="font-size:.75rem">'+(c.new_value||'—')+'</td><td style="font-size:.7rem">'+new Date(c.changed_at).toLocaleString('pt-BR')+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }
  // Interfaces
  if(ifaces.length>0){
    h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Interfaces de Rede ('+ifaces.length+')</div>';
    h+='<table><thead><tr><th>Interface</th><th>Tipo</th><th>MAC</th><th>IPs</th><th>Velocidade</th><th>Status</th></tr></thead><tbody>';
    ifaces.forEach(ifc=>{
      h+='<tr><td><strong>'+ifc.iface_name+'</strong></td><td>'+(ifc.iface_type||'ethernet')+'</td><td style="font-size:.75rem">'+(ifc.mac_address||'—')+'</td><td style="font-size:.75rem">'+(ifc.ip_addresses||'—')+'</td><td>'+(ifc.speed_mbps||'—')+'</td><td>'+(ifc.status||'—')+'</td></tr>';
    });
    h+='</tbody></table></div>';
  }`;
// Need to find the right insertion point - after the services card closing
// Find: h+='</div></div>';  (closing of services+status grid)
const oldGridClose = `h+='</div></div>';
  h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Serviços ('+svc.length+')</div>';`;
if (c.includes(oldGridClose)) {
  c = c.replace(oldGridClose, `h+='</div></div>';` + newSvcEnd.replace(`h+='</div>';`, `h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Serviços ('+svc.length+')</div>';`));
  changes++;
  console.log('[4] Incidents + changes + interfaces sections added');
}

// Update service rendering to use display_name
const oldSvcCell = `'<tr><td><strong>'+(s.service_name||'?')+'</strong></td>`;
const newSvcCell = `'<tr><td><strong>'+(s.display_name||s.service_name||'?')+'</strong></td>`;
if (c.includes(oldSvcCell) && !c.includes('display_name')) {
  c = c.replace(oldSvcCell, newSvcCell);
  changes++;
  console.log('[5] Service display_name used in table');
}

// Update banner column to show display_name + use product_hint
const oldBannerCell = `const b=(s.fingerprint&&s.fingerprint.banner)?s.fingerprint.banner.substring(0,120):'—';`;
const newBannerCell = `const b=s.banner?s.banner.substring(0,120):(s.fingerprint&&s.fingerprint.banner)?s.fingerprint.banner.substring(0,120):'—';`;
if (c.includes(oldBannerCell) && !c.includes('s.banner?')) {
  c = c.replace(oldBannerCell, newBannerCell);
  changes++;
  console.log('[6] Banner from enriched data');
}

fs.writeFileSync(file, c);
console.log('Total changes:', changes);
console.log('DONE');
