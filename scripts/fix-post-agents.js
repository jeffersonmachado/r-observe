const fs = require('fs');
const file = '/opt/results/r-observe/r-observe/api/src/index.js';
let c = fs.readFileSync(file, 'utf8');

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

if (c.includes(old)) {
  c = c.replace(old, nxt);
  fs.writeFileSync(file, c);
  console.log('POST agents handler FIXED');
} else {
  console.log('Pattern not found - checking...');
  const idx = c.indexOf('body.agents');
  console.log(c.substring(idx, idx+300));
}
