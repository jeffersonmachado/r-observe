const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// Fix renderDiscovery - add discovery toggles
{
  const old = `document.getElementById('tog-snmp_discovery').checked=false;
}`;
  const nxt = `document.getElementById('tog-snmp_discovery').checked=false;
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
}`;
  if (c.includes(old) && !c.includes('discovery_arp')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('renderDiscovery expanded');
  } else {
    console.log('renderDiscovery: already patched or not found');
  }
}

// Fix readCurrentSettings: add agents fields + monitoring
{
  const old = `    agents: {
      offline_check_enabled: document.getElementById('tog-agent_offline')?.checked,
      offline_threshold_minutes: parseInt(document.getElementById('sld-agent_timeout')?.value||5),
    },`;
  const nxt = `    agents: {
      offline_check_enabled: document.getElementById('tog-agent_offline')?.checked,
      offline_threshold_minutes: parseInt(document.getElementById('sld-agent_timeout')?.value||5),
      check_interval_seconds: parseInt(document.getElementById('sld-agent_check_interval')?.value||60),
      disk_warn_percent: parseInt(document.getElementById('sld-agent_disk_warn')?.value||80),
      docker_projects: Array.from(document.getElementById('sel-docker_projects')?.selectedOptions||[]).map(o=>o.value).join(','),
      docker_ignore_containers: Array.from(document.getElementById('sel-docker_ignore')?.selectedOptions||[]).map(o=>o.value).join(','),
    },`;
  if (c.includes(old) && !c.includes('check_interval_seconds')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('readCurrentSettings agents expanded');
  }
}

{
  const old = `    discovery_policy: {`;
  const nxt = `    monitoring: {
      icinga_sync_enabled: document.getElementById('tog-mon_icinga')?.checked,
      prometheus_sd_enabled: document.getElementById('tog-mon_prometheus')?.checked,
    },
    discovery_policy: {`;
  if (c.includes(old) && !c.includes('mon_icinga')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('readCurrentSettings monitoring added');
  }
}

// Add ASSET_DETAIL_HTML constant before the settings page HTML
{
  const htmlConst = `
// ── Asset Detail HTML ────────────────────────────────────────────────────
const ASSET_DETAIL_HTML = \`<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>R-Observe · Ativo</title>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--border:#334155;--text:#e2e8f0;--muted:#94a3b8;--accent:#3b82f6;--green:#22c55e;--red:#ef4444;--yellow:#eab308}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.topbar{display:flex;align-items:center;gap:1rem;padding:.75rem 1.5rem;background:var(--surface);border-bottom:1px solid var(--border)}
.topbar img{height:28px}
.topbar-title{font-size:.85rem;color:var(--muted)}
.topbar a{color:var(--accent);text-decoration:none;font-size:.85rem}
.topbar a:hover{text-decoration:underline}
.container{max-width:1100px;margin:0 auto;padding:1.5rem}
.back-link{display:inline-block;margin-bottom:1rem;color:var(--accent);text-decoration:none;font-size:.875rem}
h1{font-size:1.5rem;margin-bottom:.25rem}
.subtitle{color:var(--muted);margin-bottom:1.5rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1.25rem}
.card-title{font-size:.8rem;text-transform:uppercase;color:var(--muted);margin-bottom:1rem;letter-spacing:.05em}
.info-row{display:flex;justify-content:space-between;padding:.5rem 0;border-bottom:1px solid var(--border);font-size:.875rem}
.info-row:last-child{border-bottom:none}
.info-label{color:var(--muted)}
.info-value{font-weight:600;text-align:right}
.badge{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.75rem;font-weight:600}
.badge-approved{background:#166534;color:#86efac}
.badge-monitored{background:#1e40af;color:#93c5fd}
.badge-discovered{background:#713f12;color:#fde047}
.badge-ignored{background:#334155;color:#94a3b8}
.badge-quarantined{background:#7f1d1d;color:#fca5a5}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:left;color:var(--muted);font-weight:600;padding:.5rem;border-bottom:2px solid var(--border)}
td{padding:.5rem;border-bottom:1px solid var(--border)}
.status-open{color:var(--green)}
.status-closed{color:var(--red)}
.status-filtered{color:var(--yellow)}
.meta-json{font-size:.75rem;background:#0f172a;padding:.75rem;border-radius:4px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;color:var(--muted);max-height:300px;overflow-y:auto}
.loading{text-align:center;padding:3rem;color:var(--muted)}
.error{text-align:center;padding:3rem;color:var(--red)}
</style>
</head>
<body>
<div class="topbar">
  <a href="/observe/home"><img src="/observe/api/ui/logo.svg" onerror="this.style.display='none'" alt="R"/></a>
  <span class="topbar-title">Results · Sistemas de Informática / R-Observe</span>
  <span style="flex:1"></span>
  <a href="/observe/home">⌂ Home</a>
  <a href="/observe/discovery">🔍 Discovery</a>
  <a href="/observe/settings">⚙ Configuração</a>
  <a href="/observe/api/auth/logout">Sair</a>
</div>
<div class="container">
  <a href="/observe/discovery" class="back-link">← Voltar para Discovery</a>
  <div id="content"><div class="loading">Carregando...</div></div>
</div>
<script>
const ASSET_ID = '__ASSET_ID__';
function load(){
  fetch('/observe/api/assets/'+ASSET_ID,{headers:{'Accept':'application/json'}})
    .then(r=>r.ok?r.json():Promise.reject('HTTP '+r.status))
    .then(d=>render(d.asset,d.services))
    .catch(e=>document.getElementById('content').innerHTML='<div class="error">'+e+'</div>');
}
function badge(s){
  const m={approved:'approved',monitored:'monitored',discovered:'discovered',ignored:'ignored',quarantined:'quarantined'};
  return '<span class="badge badge-'+(m[s]||'ignored')+'">'+(s||'?')+'</span>';
}
function render(a,svc){
  const m=a.metadata||{};
  const sysD=m.sysDescr||m.snmp_sysDescr||'';
  const os=a.os_hint||m.os||m.snmp_os||'—';
  const v=a.vendor||m.vendor||'—';
  const p=a.product||m.product||'—';
  const up=m.snmp_sysUpTime||m.sysUptime||'—';
  const dns=a.hostname||m.dns_reverse||m.hostname||'—';
  const ip=a.primary_ip||m.ip||'—';
  const fs=a.first_seen_at?new Date(a.first_seen_at).toLocaleString('pt-BR'):'—';
  const ls=a.last_seen_at?new Date(a.last_seen_at).toLocaleString('pt-BR'):'—';
  let h='';
  h+='<h1>'+(a.display_name||a.asset_name||'Ativo')+'</h1>';
  h+='<div class="subtitle">'+a.asset_type+' · '+os+' · '+badge(a.lifecycle_state)+'</div>';
  h+='<div class="grid">';
  h+='<div class="card"><div class="card-title">Sistema</div>';
  h+=r('Nome',a.asset_name);h+=r('Display Name',a.display_name||'—');h+=r('IP',ip);
  h+=r('DNS Reverso',dns);h+=r('Tipo',a.asset_type);h+=r('Fabricante',v);h+=r('Produto',p);
  h+=r('Sistema Operacional',os);h+=r('Confiança',(a.confidence*100).toFixed(0)+'%');
  if(sysD)h+=r('sysDescr',sysD);
  h+='</div>';
  h+='<div class="card"><div class="card-title">Status</div>';
  h+=r('Estado',badge(a.lifecycle_state));h+=r('Criticalidade',a.criticality);
  h+=r('Primeira vez visto',fs);h+=r('Última vez visto',ls);
  if(up!=='—')h+=r('Uptime SNMP',up);
  h+='</div></div>';
  h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Serviços ('+svc.length+')</div>';
  if(svc.length>0){
    h+='<table><thead><tr><th>Serviço</th><th>Proto</th><th>Porta</th><th>Status</th><th>Banner</th><th>Último scan</th></tr></thead><tbody>';
    svc.forEach(s=>{
      const b=(s.fingerprint&&s.fingerprint.banner)?s.fingerprint.banner.substring(0,120):'—';
      const lss=s.last_seen_at?new Date(s.last_seen_at).toLocaleString('pt-BR'):'—';
      h+='<tr><td><strong>'+(s.service_name||'?')+'</strong></td><td>'+(s.protocol||'tcp')+'</td><td>'+s.port+'</td><td class="status-'+s.status+'">'+s.status+'</td><td style="font-size:.75rem;max-width:300px;overflow:hidden;text-overflow:ellipsis">'+b+'</td><td style="font-size:.75rem">'+lss+'</td></tr>';
    });
    h+='</tbody></table>';
  }else{h+='<p style="color:var(--muted);padding:1rem">Nenhum serviço detectado.</p>';}
  h+='</div>';
  h+='<div class="card" style="margin-top:1.5rem"><div class="card-title">Metadata (JSON)</div>';
  h+='<pre class="meta-json">'+JSON.stringify(m,null,2)+'</pre></div>';
  document.getElementById('content').innerHTML=h;
}
function r(l,v){return '<div class="info-row"><span class="info-label">'+l+'</span><span class="info-value">'+v+'</span></div>';}
load();
</script>
</body>
</html>\`;
`;
  const marker = `// ── Sistema de Configuração Abrangente`;
  if (c.includes(marker) && !c.includes('ASSET_DETAIL_HTML')) {
    c = c.replace(marker, htmlConst + marker);
    changes++;
    console.log('ASSET_DETAIL_HTML constant added');
  }
}

// Add backend endpoint for /api/assets/:id
{
  const marker = `// ─── AI settings`;
  const endpoint = `
// ─── Asset Detail ────────────────────────────────────────────────────────
app.get(\`\${BASE}/assets/:id\`, requireAuth, async (req, res) => {
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
});
${marker}`;
  if (c.includes(marker) && !c.includes('Asset Detail')) {
    c = c.replace(marker, endpoint);
    changes++;
    console.log('GET /api/assets/:id endpoint added');
  }
}

// Add /observe/assets/:id page route
{
  const marker = `app.get('/observe/discovery', async (req, res) => {`;
  const route = `app.get('/observe/assets/:id', async (req, res) => {
  try {
    const auth = await authenticateRequest(req, db, SESSION_COOKIE);
    if (!auth) return res.redirect(\`/observe/login?next=\${encodeURIComponent('/observe/assets/'+req.params.id)}\`);
    req.auth = auth;
  } catch (_) {
    return res.redirect(\`/observe/login?next=\${encodeURIComponent('/observe/assets/'+req.params.id)}\`);
  }
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(ASSET_DETAIL_HTML.replace('__ASSET_ID__', req.params.id));
});

${marker}`;
  if (c.includes(marker) && !c.includes('/observe/assets/:id')) {
    c = c.replace(marker, route);
    changes++;
    console.log('/observe/assets/:id page route added');
  }
}

fs.writeFileSync(file, c);
console.log('Total changes:', changes);
console.log('DONE');
