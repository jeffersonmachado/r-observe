'use strict';
// Patch local source: /opt/results/r-observe/r-observe/api/src/index.js
const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// 1. Add SNMP section to renderDiscovery (before the closing })
{
  const old = `  document.getElementById('sld-grace').value=2;document.getElementById('sldv-grace').textContent='2 scans';
}`;
  const nxt = `  document.getElementById('sld-grace').value=2;document.getElementById('sldv-grace').textContent='2 scans';
  el.appendChild(h('div',{className:'field'},[h('div',{},toggle('snmp_discovery')),h('div',{className:'toggle-desc'},'Ativar descoberta SNMP (sysDescr, OS, interfaces)')]));
  el.appendChild(h('div',{className:'field'},[h('label',{},'SNMP Community'),h('input',{type:'text',id:'txt-snmp_community',value:'public',style:'width:100%;padding:.5rem;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:4px',onchange:'markDirty()'})]));
  document.getElementById('tog-snmp_discovery').checked=false;
}`;
  if (c.includes(old) && !c.includes('snmp_discovery')) {
    c = c.replace(old, nxt);
    changes++;
    console.log('[1] renderDiscovery SNMP section added');
  } else {
    console.log('[1] Already patched or pattern not found');
  }
}

// 2. Add discovery_policy to readCurrentSettings
{
  const old = `    os_defaults: {
      linux_node_exporter: document.getElementById('tog-os_linux')?.checked,
      windows_exporter: document.getElementById('tog-os_win')?.checked,
      network_snmp: document.getElementById('tog-os_snmp')?.checked,
    },
  };`;
  if (c.includes(old)) {
    c = c.replace(old, old.replace('  };', `
    discovery_policy: {
      snmp_enabled: document.getElementById('tog-snmp_discovery')?.checked,
      snmp_community: document.getElementById('txt-snmp_community')?.value || 'public',
    },
  };`));
    changes++;
    console.log('[2] readCurrentSettings patched');
  } else {
    console.log('[2] Pattern not found');
  }
}

// 3. Make POST handler async
{
  const old = `app.post(\`\${BASE}/system/settings\`, requireAuth, requireAdmin, (req, res) => {`;
  if (c.includes(old) && !c.includes('async (req, res)')) {
    c = c.replace(old, `app.post(\`\${BASE}/system/settings\`, requireAuth, requireAdmin, async (req, res) => {`);
    changes++;
    console.log('[3] Handler made async');
  } else {
    console.log('[3] Already async or not found');
  }
}

// 4. Add discovery_policy backend handler before os_defaults
{
  const old = `  if (body.os_defaults) {`;
  if (c.includes(old) && !c.includes('body.discovery_policy')) {
    c = c.replace(old, `  if (body.discovery_policy) {
    const db2 = require('./db').createDbClient(process.env);
    try {
      await db2.query(
        \`UPDATE observe_discovery_policies SET metadata = COALESCE(metadata, '{}'::jsonb) || \$1::jsonb, updated_at = NOW() WHERE tenant_id = 'default' AND site_id = 'default-site' AND edge_id = 'central'\`,
        [JSON.stringify({snmp_enabled: !!body.discovery_policy.snmp_enabled, snmp_community: String(body.discovery_policy.snmp_community || 'public')})]
      );
    } catch (_) {}
    await db2.end().catch(() => {});
  }
  if (body.os_defaults) {`);
    changes++;
    console.log('[4] Backend discovery_policy handler added');
  } else {
    console.log('[4] Already present or not found');
  }
}

// 5. Fix h() safety check
{
  const old = `  children.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c) el.appendChild(c); });`;
  if (c.includes(old) && !c.includes('instanceof Node')) {
    c = c.replace(old, `  children.forEach(c => { if (typeof c==='string') el.appendChild(document.createTextNode(c)); else if (c instanceof Node) el.appendChild(c); });`);
    changes++;
    console.log('[5] h() instanceof Node safety');
  } else {
    console.log('[5] Already fixed or not found');
  }
}

fs.writeFileSync(file, c);
console.log('Total changes:', changes);
console.log('DONE');
