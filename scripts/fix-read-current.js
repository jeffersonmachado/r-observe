const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');
let changes = 0;

// Fix readCurrentSettings: replace the entire function body
const oldFn = `function readCurrentSettings(){
  return {
    discovery: {
      port_change_detection: document.getElementById('tog-port_change')?.checked,
      port_disappeared_grace_scans: parseInt(document.getElementById('sld-grace')?.value||2),
    },
    agents: {
      offline_check_enabled: document.getElementById('tog-agent_offline')?.checked,
      offline_threshold_minutes: parseInt(document.getElementById('sld-agent_timeout')?.value||5),
    },
    certs: {
      expiry_warning_days: parseInt(document.getElementById('sld-cert_warn')?.value||30),
      expiry_critical_days: parseInt(document.getElementById('sld-cert_crit')?.value||7),
    },
    os_defaults: {
      linux_node_exporter: document.getElementById('tog-os_linux')?.checked,
      windows_exporter: document.getElementById('tog-os_win')?.checked,
      network_snmp: document.getElementById('tog-os_snmp')?.checked,
    },

    discovery_policy: {
      snmp_enabled: document.getElementById('tog-snmp_discovery')?.checked,
      snmp_community: document.getElementById('txt-snmp_community')?.value || 'public',
    },
  };
}`;

const newFn = `function readCurrentSettings(){
  return {
    discovery: {
      port_change_detection: document.getElementById('tog-port_change')?.checked,
      port_disappeared_grace_scans: parseInt(document.getElementById('sld-grace')?.value||2),
      arp_enabled: document.getElementById('tog-discovery_arp')?.checked,
      docker_enabled: document.getElementById('tog-discovery_docker')?.checked,
      cloud_enabled: document.getElementById('tog-discovery_cloud')?.checked,
      passive_enabled: document.getElementById('tog-discovery_passive')?.checked,
      scan_parallel: parseInt(document.getElementById('sld-scan_parallel')?.value||20),
      extra_ports: document.getElementById('txt-extra_ports')?.value || '',
    },
    agents: {
      offline_check_enabled: document.getElementById('tog-agent_offline')?.checked,
      offline_threshold_minutes: parseInt(document.getElementById('sld-agent_timeout')?.value||5),
      check_interval_seconds: parseInt(document.getElementById('sld-agent_check_interval')?.value||60),
      disk_warn_percent: parseInt(document.getElementById('sld-agent_disk_warn')?.value||80),
      docker_projects: Array.from(document.getElementById('sel-docker_projects')?.selectedOptions||[]).map(o=>o.value).join(','),
      docker_ignore_containers: Array.from(document.getElementById('sel-docker_ignore')?.selectedOptions||[]).map(o=>o.value).join(','),
    },
    certs: {
      expiry_warning_days: parseInt(document.getElementById('sld-cert_warn')?.value||30),
      expiry_critical_days: parseInt(document.getElementById('sld-cert_crit')?.value||7),
    },
    os_defaults: {
      linux_node_exporter: document.getElementById('tog-os_linux')?.checked,
      windows_exporter: document.getElementById('tog-os_win')?.checked,
      network_snmp: document.getElementById('tog-os_snmp')?.checked,
    },
    monitoring: {
      icinga_sync_enabled: document.getElementById('tog-mon_icinga')?.checked,
      prometheus_sd_enabled: document.getElementById('tog-mon_prometheus')?.checked,
    },
    discovery_policy: {
      snmp_enabled: document.getElementById('tog-snmp_discovery')?.checked,
      snmp_community: document.getElementById('txt-snmp_community')?.value || 'public',
    },
  };
}`;

if (c.includes(oldFn)) {
  c = c.replace(oldFn, newFn);
  changes++;
  console.log('[1] readCurrentSettings fully expanded');
} else {
  console.log('[1] Pattern not found - checking...');
  // Find the function start
  const idx = c.indexOf('function readCurrentSettings(){');
  console.log('Found at:', idx);
  console.log(c.substring(idx, idx + 200));
}

if (changes > 0) {
  fs.writeFileSync(file, c);
  console.log('Total changes:', changes, 'DONE');
}
