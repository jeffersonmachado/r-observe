'use strict';
// Add device detail page to R-Observe API
const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// ═══════════════════════════════════════════════════════════════════
// 1. Backend endpoint: GET /observe/api/assets/:id
// ═══════════════════════════════════════════════════════════════════
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
    console.log('[1] GET /assets/:id endpoint added');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 2. HTML page: GET /observe/assets/:id
// ═══════════════════════════════════════════════════════════════════
{
  const marker = `app.get('/observe/discovery', async (req, res) => {`;
  const pageRoute = `app.get('/observe/assets/:id', async (req, res) => {
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
  if (c.includes(marker) && !c.includes('observe/assets/:id')) {
    c = c.replace(marker, pageRoute);
    changes++;
    console.log('[2] GET /observe/assets/:id page route added');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3. ASSET_DETAIL_HTML constant (before the last app.get or at end)
// ═══════════════════════════════════════════════════════════════════
{
  const marker = `// ── Inicialização ──`;
  const html = `
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
.back-link:hover{text-decoration:underline}
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
const API = '/observe/api';

async function load(){
  try {
    const r = await fetch(API+'/assets/'+ASSET_ID, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) { document.getElementById('content').innerHTML = '<div class="error">Ativo não encontrado (HTTP '+r.status+')</div>'; return; }
    const data = await r.json();
    render(data.asset, data.services);
  } catch(e) {
    document.getElementById('content').innerHTML = '<div class="error">Erro: '+e.message+'</div>';
  }
}

function badge(state){
  const map={approved:'approved',monitored:'monitored',discovered:'discovered',ignored:'ignored',quarantined:'quarantined',disappeared:'quarantined'};
  return '<span class="badge badge-'+(map[state]||'ignored')+'">'+(state||'?')+'</span>';
}

function render(asset, services){
  const m = asset.metadata || {};
  const sysDescr = m.sysDescr || m.snmp_sysDescr || '';
  const osHint = asset.os_hint || m.os || m.snmp_os || '—';
  const vendor = asset.vendor || m.vendor || '—';
  const product = asset.product || m.product || '—';
  const uptime = m.snmp_sysUpTime || m.sysUptime || '—';
  const dnsName = asset.hostname || m.dns_reverse || m.hostname || '—';
  const firstSeen = asset.first_seen_at ? new Date(asset.first_seen_at).toLocaleString('pt-BR') : '—';
  const lastSeen = asset.last_seen_at ? new Date(asset.last_seen_at).toLocaleString('pt-BR') : '—';
  const ip = asset.primary_ip || m.ip || '—';
  
  let html = '<h1>'+(asset.display_name || asset.asset_name || 'Ativo')+'</h1>';
  html += '<div class="subtitle">'+asset.asset_type+' · '+osHint+' · '+badge(asset.lifecycle_state)+'</div>';
  
  html += '<div class="grid">';
  
  // System info card
  html += '<div class="card"><div class="card-title">Sistema</div>';
  html += row('Nome', asset.asset_name);
  html += row('Display Name', asset.display_name || '—');
  html += row('IP', ip);
  html += row('DNS Reverso', dnsName);
  html += row('Tipo', asset.asset_type);
  html += row('Fabricante', vendor);
  html += row('Produto', product);
  html += row('Sistema Operacional', osHint);
  html += row('Confiança', (asset.confidence*100).toFixed(0)+'%');
  if (sysDescr) html += row('sysDescr', sysDescr);
  html += '</div>';
  
  // Status card
  html += '<div class="card"><div class="card-title">Status</div>';
  html += row('Estado', badge(asset.lifecycle_state));
  html += row('Criticalidade', asset.criticality);
  html += row('Primeira vez visto', firstSeen);
  html += row('Última vez visto', lastSeen);
  if (uptime !== '—') html += row('Uptime SNMP', uptime);
  html += '</div>';
  
  html += '</div>';
  
  // Services table
  html += '<div class="card" style="margin-top:1.5rem"><div class="card-title">Serviços ('+services.length+')</div>';
  if (services.length > 0) {
    html += '<table><thead><tr><th>Serviço</th><th>Protocolo</th><th>Porta</th><th>Status</th><th>Banner</th><th>Último scan</th></tr></thead><tbody>';
    services.forEach(s => {
      const banner = (s.fingerprint && s.fingerprint.banner) ? s.fingerprint.banner.substring(0,120) : '—';
      const lastSeenS = s.last_seen_at ? new Date(s.last_seen_at).toLocaleString('pt-BR') : '—';
      html += '<tr><td><strong>'+(s.service_name||'?')+'</strong></td><td>'+(s.protocol||'tcp')+'</td><td>'+s.port+'</td><td class="status-'+s.status+'">'+s.status+'</td><td style="font-size:.75rem;max-width:300px;overflow:hidden;text-overflow:ellipsis">'+banner+'</td><td style="font-size:.75rem">'+lastSeenS+'</td></tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<p style="color:var(--muted);padding:1rem">Nenhum serviço detectado.</p>';
  }
  html += '</div>';
  
  // Metadata card
  html += '<div class="card" style="margin-top:1.5rem"><div class="card-title">Metadata (JSON)</div>';
  html += '<pre class="meta-json">'+JSON.stringify(m, null, 2)+'</pre>';
  html += '</div>';
  
  document.getElementById('content').innerHTML = html;
}

function row(label, value){
  return '<div class="info-row"><span class="info-label">'+label+'</span><span class="info-value">'+value+'</span></div>';
}

load();
</script>
</body>
</html>\`;
${marker}`;
  if (c.includes(marker) && !c.includes('ASSET_DETAIL_HTML')) {
    c = c.replace(marker, html);
    changes++;
    console.log('[3] ASSET_DETAIL_HTML constant added');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4. Add nginx proxy route for /observe/assets/
// ═══════════════════════════════════════════════════════════════════
// Note: this needs to be in the nginx config. We'll add to the proxy container separately.

fs.writeFileSync(file, c);
console.log('Total changes:', changes);
console.log('DONE');
