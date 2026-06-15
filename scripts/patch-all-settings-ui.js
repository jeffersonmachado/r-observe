'use strict';
// Patch completo: todos os parâmetros de env var → UI settings
const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// ═══════════════════════════════════════════════════════════════════
// 1. SYSTEM_SETTINGS_DEFAULTS - add new fields
// ═══════════════════════════════════════════════════════════════════
{
  const old = `  agents: {
    offline_threshold_minutes: Math.round(parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10) / 60000),
    offline_check_enabled: process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false',
  },`;
  const nxt = `  agents: {
    offline_threshold_minutes: Math.round(parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10) / 60000),
    offline_check_enabled: process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false',
    check_interval_seconds: parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10) / 1000,
    disk_warn_percent: parseInt(process.env.DISK_WARN_PERCENT || '80', 10),
    docker_projects: (process.env.OBSERVE_DOCKER_PROJECTS || ''),
    docker_ignore_containers: (process.env.OBSERVE_DOCKER_IGNORE_CONTAINERS || ''),
  },`;
  if (c.includes(old) && !c.includes('check_interval_seconds')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[1] SYSTEM_SETTINGS_DEFAULTS agents expanded');
  } else {
    console.log('[1] Already patched or not found');
  }
}

{
  const old = `  discovery: {
    scan_interval_minutes: parseInt(process.env.DISCOVERY_SCAN_INTERVAL_MINUTES || '60', 10),
    arp_enabled: process.env.DISCOVERY_ARP_ENABLED !== 'false',
    docker_enabled: process.env.DISCOVERY_DOCKER_ENABLED === 'true',
    cloud_enabled: process.env.DISCOVERY_CLOUD_AWS_ENABLED === 'true',
    passive_enabled: process.env.DISCOVERY_PASSIVE_LISTENERS_ENABLED !== 'false',
    port_change_detection: process.env.DISCOVERY_PORT_CHANGE_DETECTION !== 'false',
    port_disappeared_grace_scans: parseInt(process.env.DISCOVERY_PORT_DISAPPEARED_GRACE || '2', 10),
  },`;
  const nxt = `  discovery: {
    scan_interval_minutes: parseInt(process.env.DISCOVERY_SCAN_INTERVAL_MINUTES || '60', 10),
    arp_enabled: process.env.DISCOVERY_ARP_ENABLED !== 'false',
    docker_enabled: process.env.DISCOVERY_DOCKER_ENABLED === 'true',
    cloud_enabled: process.env.DISCOVERY_CLOUD_AWS_ENABLED === 'true',
    passive_enabled: process.env.DISCOVERY_PASSIVE_LISTENERS_ENABLED !== 'false',
    port_change_detection: process.env.DISCOVERY_PORT_CHANGE_DETECTION !== 'false',
    port_disappeared_grace_scans: parseInt(process.env.DISCOVERY_PORT_DISAPPEARED_GRACE || '2', 10),
    scan_parallel: parseInt(process.env.DISCOVERY_SCAN_PARALLEL || '20', 10),
    extra_ports: (process.env.DISCOVERY_EXTRA_PORTS || ''),
  },`;
  if (c.includes(old) && !c.includes('scan_parallel:')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[1b] SYSTEM_SETTINGS_DEFAULTS discovery expanded');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 2. loadSystemSettings() - mirror defaults
// ═══════════════════════════════════════════════════════════════════
{
  const old = `  _systemSettings = {
    discovery: {
      scan_interval_minutes: parseInt(process.env.DISCOVERY_SCAN_INTERVAL_MINUTES || '60', 10),
      arp_enabled: process.env.DISCOVERY_ARP_ENABLED !== 'false',
      docker_enabled: process.env.DISCOVERY_DOCKER_ENABLED === 'true',
      cloud_enabled: process.env.DISCOVERY_CLOUD_AWS_ENABLED === 'true',
      passive_enabled: process.env.DISCOVERY_PASSIVE_LISTENERS_ENABLED !== 'false',
      port_change_detection: process.env.DISCOVERY_PORT_CHANGE_DETECTION !== 'false',
      port_disappeared_grace_scans: parseInt(process.env.DISCOVERY_PORT_DISAPPEARED_GRACE || '2', 10),
    },
    agents: {
      offline_threshold_minutes: Math.round(parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10) / 60000),
      offline_check_enabled: process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false',
    },`;
  const nxt = `  _systemSettings = {
    discovery: {
      scan_interval_minutes: parseInt(process.env.DISCOVERY_SCAN_INTERVAL_MINUTES || '60', 10),
      arp_enabled: process.env.DISCOVERY_ARP_ENABLED !== 'false',
      docker_enabled: process.env.DISCOVERY_DOCKER_ENABLED === 'true',
      cloud_enabled: process.env.DISCOVERY_CLOUD_AWS_ENABLED === 'true',
      passive_enabled: process.env.DISCOVERY_PASSIVE_LISTENERS_ENABLED !== 'false',
      port_change_detection: process.env.DISCOVERY_PORT_CHANGE_DETECTION !== 'false',
      port_disappeared_grace_scans: parseInt(process.env.DISCOVERY_PORT_DISAPPEARED_GRACE || '2', 10),
      scan_parallel: parseInt(process.env.DISCOVERY_SCAN_PARALLEL || '20', 10),
      extra_ports: (process.env.DISCOVERY_EXTRA_PORTS || ''),
    },
    agents: {
      offline_threshold_minutes: Math.round(parseInt(process.env.AGENT_OFFLINE_THRESHOLD_MS || '300000', 10) / 60000),
      offline_check_enabled: process.env.AGENT_OFFLINE_CHECK_ENABLED !== 'false',
      check_interval_seconds: parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10) / 1000,
      disk_warn_percent: parseInt(process.env.DISK_WARN_PERCENT || '80', 10),
      docker_projects: (process.env.OBSERVE_DOCKER_PROJECTS || ''),
      docker_ignore_containers: (process.env.OBSERVE_DOCKER_IGNORE_CONTAINERS || ''),
    },`;
  if (c.includes(old) && !c.includes('loadSystemSettings.*check_interval')) {
    // Count occurrences - there are 2 (defaults + loadSystemSettings)
    const count = c.split(old).length - 1;
    if (count >= 1) {
      // Replace only the one in loadSystemSettings (second occurrence)
      const idx = c.indexOf(old);
      const idx2 = c.indexOf(old, idx + old.length);
      if (idx2 >= 0) {
        c = c.substring(0, idx2) + nxt + c.substring(idx2 + old.length);
        changes++;
        console.log('[2] loadSystemSettings expanded (second occurrence)');
      } else {
        // Only one occurrence, replace it
        c = c.replace(old, nxt);
        changes++;
        console.log('[2] loadSystemSettings expanded');
      }
    }
  } else {
    console.log('[2] Already patched');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 3. POST /system/settings - add save handlers
// ═══════════════════════════════════════════════════════════════════
{
  const old = `  if (body.discovery) {
    if (typeof body.discovery.port_change_detection === 'boolean')
      _systemSettings.discovery.port_change_detection = body.discovery.port_change_detection;
    if (typeof body.discovery.port_disappeared_grace_scans === 'number')
      _systemSettings.discovery.port_disappeared_grace_scans = body.discovery.port_disappeared_grace_scans;
  }`;
  const nxt = `  if (body.discovery) {
    if (typeof body.discovery.port_change_detection === 'boolean')
      _systemSettings.discovery.port_change_detection = body.discovery.port_change_detection;
    if (typeof body.discovery.port_disappeared_grace_scans === 'number')
      _systemSettings.discovery.port_disappeared_grace_scans = body.discovery.port_disappeared_grace_scans;
    if (typeof body.discovery.arp_enabled === 'boolean')
      _systemSettings.discovery.arp_enabled = body.discovery.arp_enabled;
    if (typeof body.discovery.docker_enabled === 'boolean')
      _systemSettings.discovery.docker_enabled = body.discovery.docker_enabled;
    if (typeof body.discovery.cloud_enabled === 'boolean')
      _systemSettings.discovery.cloud_enabled = body.discovery.cloud_enabled;
    if (typeof body.discovery.passive_enabled === 'boolean')
      _systemSettings.discovery.passive_enabled = body.discovery.passive_enabled;
    if (typeof body.discovery.scan_parallel === 'number')
      _systemSettings.discovery.scan_parallel = body.discovery.scan_parallel;
    if (typeof body.discovery.extra_ports === 'string')
      _systemSettings.discovery.extra_ports = body.discovery.extra_ports;
  }`;
  if (c.includes(old) && !c.includes('discovery.arp_enabled')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[3] POST discovery handler expanded');
  } else {
    console.log('[3] Already patched');
  }
}

{
  const old = `  if (body.agents) {
    if (typeof body.agents.offline_check_enabled === 'boolean')
      _systemSettings.agents.offline_check_enabled = body.agents.offline_check_enabled;
    if (typeof body.agents.offline_threshold_minutes === 'number')
      _systemSettings.agents.offline_threshold_minutes = body.agents.offline_threshold_minutes;
  }`;
  const nxt = `  if (body.agents) {
    if (typeof body.agents.offline_check_enabled === 'boolean')
      _systemSettings.agents.offline_check_enabled = body.agents.offline_check_enabled;
    if (typeof body.agents.offline_threshold_minutes === 'number')
      _systemSettings.agents.offline_threshold_minutes = body.agents.offline_threshold_minutes;
    if (typeof body.agents.check_interval_seconds === 'number')
      _systemSettings.agents.check_interval_seconds = body.agents.check_interval_seconds;
    if (typeof body.agents.disk_warn_percent === 'number')
      _systemSettings.agents.disk_warn_percent = body.agents.disk_warn_percent;
    if (typeof body.agents.docker_projects === 'string')
      _systemSettings.agents.docker_projects = body.agents.docker_projects;
    if (typeof body.agents.docker_ignore_containers === 'string')
      _systemSettings.agents.docker_ignore_containers = body.agents.docker_ignore_containers;
  }`;
  if (c.includes(old) && !c.includes('check_interval_seconds')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[3b] POST agents handler expanded');
  }
}

// Add monitoring save handler
{
  const old = `  if (body.discovery_policy) {`;
  const nxt = `  if (body.monitoring) {
    if (typeof body.monitoring.icinga_sync_enabled === 'boolean')
      _systemSettings.monitoring.icinga_sync_enabled = body.monitoring.icinga_sync_enabled;
    if (typeof body.monitoring.prometheus_sd_enabled === 'boolean')
      _systemSettings.monitoring.prometheus_sd_enabled = body.monitoring.prometheus_sd_enabled;
  }
  if (body.discovery_policy) {`;
  if (c.includes(old) && !c.includes('body.monitoring')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[3c] POST monitoring handler added');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 4. HTML tabs - add Monitoring tab
// ═══════════════════════════════════════════════════════════════════
{
  const old = `    <button class="tab-btn" onclick="switchTab('certs')">🔒 Certs</button>`;
  const nxt = `    <button class="tab-btn" onclick="switchTab('certs')">🔒 Certs</button>
    <button class="tab-btn" onclick="switchTab('monitoring')">📊 Monitoramento</button>`;
  if (c.includes(old) && !c.includes('switchTab(\'monitoring\')')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[4] Monitoring tab added to HTML');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 5. switchTab() - add monitoring + fix tab detection
// ═══════════════════════════════════════════════════════════════════
{
  const old = `  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.textContent.includes(
    tab==='discovery'?'Descoberta':tab==='ai'?'IA':tab==='agents'?'Agentes':tab==='os'?'SO':'Certs')));
  const p=document.getElementById('settings-panel');
  if(tab==='discovery') renderDiscovery(p);
  else if(tab==='ai') renderAI(p);
  else if(tab==='agents') renderAgents(p);
  else if(tab==='os') renderOS(p);
  else if(tab==='certs') renderCerts(p);`;
  const nxt = `  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.textContent.includes(
    tab==='discovery'?'Descoberta':tab==='ai'?'IA':tab==='agents'?'Agentes':tab==='os'?'SO':tab==='certs'?'Certs':'Monitoramento')));
  const p=document.getElementById('settings-panel');
  if(tab==='discovery') renderDiscovery(p);
  else if(tab==='ai') renderAI(p);
  else if(tab==='agents') renderAgents(p);
  else if(tab==='os') renderOS(p);
  else if(tab==='certs') renderCerts(p);
  else if(tab==='monitoring') renderMonitoring(p);`;
  if (c.includes(old) && !c.includes('renderMonitoring')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[5] switchTab updated for monitoring');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 6. renderDiscovery() - add toggles
// ═══════════════════════════════════════════════════════════════════
{
  const old = `  document.getElementById('tog-snmp_discovery').checked=false;
}`;
  const nxt = `  document.getElementById('tog-snmp_discovery').checked=false;
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
    console.log('[6] renderDiscovery expanded');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 7. renderAgents() - add interval, disk, docker fields
// ═══════════════════════════════════════════════════════════════════
{
  const old = `  document.getElementById('tog-agent_offline').checked=true;
  document.getElementById('sld-agent_timeout').value=5;document.getElementById('sldv-agent_timeout').textContent='5 min';
}`;
  const nxt = `  document.getElementById('tog-agent_offline').checked=true;
  document.getElementById('sld-agent_timeout').value=5;document.getElementById('sldv-agent_timeout').textContent='5 min';
  el.appendChild(h('div',{className:'field'},[h('label',{},'Intervalo de check do agente'),slider('agent_check_interval',10,600,10,60,' seg')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Alerta de disco (%)'),slider('agent_disk_warn',50,99,1,80,'%')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Projetos Docker monitorados'),h('input',{type:'text',id:'txt-docker_projects',value:'',placeholder:'infra,infra-mail',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'Contêineres ignorados'),h('input',{type:'text',id:'txt-docker_ignore',value:'',placeholder:'bootstrap,certs',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));
  document.getElementById('sld-agent_check_interval').value=60;document.getElementById('sldv-agent_check_interval').textContent='60 seg';
  document.getElementById('sld-agent_disk_warn').value=80;document.getElementById('sldv-agent_disk_warn').textContent='80%';
}`;
  if (c.includes(old) && !c.includes('agent_check_interval')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[7] renderAgents expanded');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 8. renderMonitoring() - new tab
// ═══════════════════════════════════════════════════════════════════
{
  const marker = `// ── Certs Tab ──`;
  const insertion = `// ── Monitoring Tab ──
function renderMonitoring(el){
  el.innerHTML='';
  el.appendChild(h('div',{className:'panel-title'},'Monitoramento'));
  el.appendChild(h('div',{className:'field'},[toggle('mon_icinga'),h('div',{className:'toggle-desc'},'Sincronizar hosts com Icinga2')]));
  el.appendChild(h('div',{className:'field'},[toggle('mon_prometheus'),h('div',{className:'toggle-desc'},'Gerar Prometheus Service Discovery (file_sd)')]));
  document.getElementById('tog-mon_icinga').checked=true;
  document.getElementById('tog-mon_prometheus').checked=true;
}
${marker}`;
  if (c.includes(marker) && !c.includes('function renderMonitoring')) {
    c = c.replace(marker, insertion);
    changes++;
    console.log('[8] renderMonitoring created');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 9. readCurrentSettings() - add all new fields
// ═══════════════════════════════════════════════════════════════════
{
  const old = `    discovery: {
      port_change_detection: document.getElementById('tog-port_change')?.checked,
      port_disappeared_grace_scans: parseInt(document.getElementById('sld-grace')?.value||2),
    },`;
  const nxt = `    discovery: {
      port_change_detection: document.getElementById('tog-port_change')?.checked,
      port_disappeared_grace_scans: parseInt(document.getElementById('sld-grace')?.value||2),
      arp_enabled: document.getElementById('tog-discovery_arp')?.checked,
      docker_enabled: document.getElementById('tog-discovery_docker')?.checked,
      cloud_enabled: document.getElementById('tog-discovery_cloud')?.checked,
      passive_enabled: document.getElementById('tog-discovery_passive')?.checked,
      scan_parallel: parseInt(document.getElementById('sld-scan_parallel')?.value||20),
      extra_ports: document.getElementById('txt-extra_ports')?.value || '',
    },`;
  if (c.includes(old) && !c.includes('discovery_arp')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[9a] readCurrentSettings discovery expanded');
  }
}

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
      docker_projects: document.getElementById('txt-docker_projects')?.value || '',
      docker_ignore_containers: document.getElementById('txt-docker_ignore')?.value || '',
    },`;
  if (c.includes(old) && !c.includes('check_interval_seconds')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[9b] readCurrentSettings agents expanded');
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
    console.log('[9c] readCurrentSettings monitoring added');
  }
}

fs.writeFileSync(file, c);
console.log('Total changes:', changes);
console.log('DONE');
