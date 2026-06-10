'use strict';

const Docker = require('dockerode');
const fs = require('fs');
const os = require('os');
const { log, info, warn, debug, isDebug } = require('../utils/logger');

function getDocker() {
  return new Docker({ socketPath: '/var/run/docker.sock' });
}

/**
 * Descobre o container ID do próprio container (self).
 * Tenta via /proc/self/cgroup, /proc/1/cgroup, ou hostname.
 */
function getSelfContainerId() {
  try {
    // /proc/self/cgroup — formato Docker: "0::/docker/<container_id>"
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const match = cgroup.match(/docker[\/-]([a-f0-9]{12,64})/i);
    if (match) return match[1];
  } catch (_) {}

  try {
    // /proc/1/cgroup (fallback se rodar como PID 1)
    const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
    const match = cgroup.match(/docker[\/-]([a-f0-9]{12,64})/i);
    if (match) return match[1];
  } catch (_) {}

  // Fallback: hostname = container ID (Docker default)
  return os.hostname().slice(0, 12);
}

/**
 * Auto-attach em TODAS as redes Docker disponíveis.
 * Usa a Docker API para listar redes e conectar este container a cada uma.
 *
 * Segurança:
 * - Pula redes com 'internal: true' se DISCOVERY_DOCKER_ATTACH_INTERNAL=false
 * - Pula redes já conectadas
 * - Pula redes com nomes em DENY_LIST
 *
 * Env vars:
 *   DISCOVERY_DOCKER_AUTO_ATTACH=true   (default: true)
 *   DISCOVERY_DOCKER_ATTACH_INTERNAL=false  (default: true — conecta em todas)
 *   DISCOVERY_DOCKER_ATTACH_DENY=host,none  (redes a pular)
 */
async function autoAttachAllNetworks() {
  const enabled = process.env.DISCOVERY_DOCKER_AUTO_ATTACH !== 'false';
  if (!enabled) {
    info('Docker auto-attach disabled via DISCOVERY_DOCKER_AUTO_ATTACH');
    return [];
  }

  const attachInternal = process.env.DISCOVERY_DOCKER_ATTACH_INTERNAL !== 'false';
  const denyList = new Set((process.env.DISCOVERY_DOCKER_ATTACH_DENY || 'host,none').split(',').map(s => s.trim()));

  let docker;
  try {
    docker = getDocker();
  } catch (e) {
    warn('Docker socket not available, skipping auto-attach', { error: e.message });
    return [];
  }

  const selfId = getSelfContainerId();
  if (!selfId) {
    warn('Could not determine self container ID, skipping auto-attach');
    return [];
  }

  info(`Docker auto-attach: self container=${selfId}`);

  let networks;
  try {
    networks = await docker.listNetworks({});
  } catch (e) {
    warn('Failed to list Docker networks', { error: e.message });
    return [];
  }

  // Listar redes atuais do container para evitar reconexão
  let currentNetworks = new Set();
  try {
    const selfInspect = await docker.getContainer(selfId).inspect();
    currentNetworks = new Set(Object.keys(selfInspect.NetworkSettings?.Networks || {}));
  } catch (_) {}

  const attached = [];
  for (const net of networks) {
    const netName = net.Name;

    // Pular redes na deny list
    if (denyList.has(netName)) {
      if (isDebug()) debug(`docker:auto-attach:skip deny=${netName}`);
      continue;
    }

    // Pular redes já conectadas
    if (currentNetworks.has(netName)) {
      if (isDebug()) debug(`docker:auto-attach:skip already-connected=${netName}`);
      continue;
    }

    // Pular redes internal se configurado
    if (net.Internal && !attachInternal) {
      if (isDebug()) debug(`docker:auto-attach:skip internal=${netName}`);
      continue;
    }

    // Pular redes sem driver bridge/overlay (ex: macvlan, ipvlan)
    if (net.Driver !== 'bridge' && net.Driver !== 'overlay') {
      if (isDebug()) debug(`docker:auto-attach:skip driver=${net.Driver} net=${netName}`);
      continue;
    }

    try {
      await docker.getNetwork(net.Id).connect({ Container: selfId });
      attached.push({ name: netName, id: net.Id, driver: net.Driver, internal: net.Internal });
      info(`Docker auto-attach: connected to ${netName} (${net.Driver}${net.Internal ? ', internal' : ''})`);
    } catch (e) {
      // Erro esperado: redes sem conectividade (ex: redes de outros compose projects)
      if (isDebug()) {
        debug(`docker:auto-attach:failed net=${netName}`, { error: e.message });
      }
    }
  }

  if (attached.length > 0) {
    info(`Docker auto-attach: connected to ${attached.length} new network(s)`, {
      networks: attached.map(a => a.name),
    });
  } else {
    info('Docker auto-attach: no new networks to attach');
  }

  return attached;
}

async function discoverLocalDocker() {
  try {
    const docker = getDocker();
    const list = await docker.listContainers({ all: true });
    const result = [];
    for (const c of list) {
      const name = (c.Names?.[0] || '').replace(/^\//, '');
      const networks = c.NetworkSettings?.Networks || {};
      const ips = Object.values(networks).map(n => n.IPAddress).filter(Boolean);
      const info = await docker.getContainer(c.Id).inspect().catch(() => null);
      const env = (info?.Config?.Env || []).reduce((acc, e) => {
        const [k, ...v] = e.split('=');
        acc[k] = v.join('=');
        return acc;
      }, {});
      result.push({
        container_id: c.Id.slice(0, 12),
        name,
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: (c.Ports || []).map(p => ({
          private: p.PrivatePort,
          public: p.PublicPort,
          type: p.Type,
          ip: p.IP || '0.0.0.0',
        })),
        ips,
        labels: c.Labels || {},
        env_hints: {
          has_ldap: !!(env.LDAP_ADMIN_PASSWORD || env.LDAP_DOMAIN),
          has_db: !!(env.MYSQL_DATABASE || env.POSTGRES_DB),
          has_mail: !!(env.MAIL_DOMAIN || env.SMTP_HOST),
        },
        source: 'docker-local',
      });
    }
    return result;
  } catch (e) {
    log('warn', 'Docker local discovery failed', { err: e?.message, code: e?.code });
    return [];
  }
}

module.exports = { discoverLocalDocker, autoAttachAllNetworks };
