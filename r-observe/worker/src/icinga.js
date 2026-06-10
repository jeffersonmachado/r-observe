'use strict';

const https = require('https');

const ICINGA_API_URL      = process.env.ICINGA_API_URL      || 'https://observe-icinga2:5665';
const ICINGA_API_USER     = process.env.ICINGA_API_USER     || 'icingaweb2';
const ICINGA_API_PASSWORD = process.env.ICINGA_API_PASSWORD || '';

// Faz uma requisição HTTP/S para a API do Icinga2.
// Usa https.request nativo (não o fetch global) para poder ignorar o cert auto-assinado.
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!ICINGA_API_PASSWORD) {
      return resolve({ ok: false, status: 0, data: { error: 'ICINGA_API_PASSWORD não configurado' } });
    }
    const parsed = new URL(`${ICINGA_API_URL}/v1${path}`);
    const auth   = Buffer.from(`${ICINGA_API_USER}:${ICINGA_API_PASSWORD}`).toString('base64');
    const bodyData = body !== null ? JSON.stringify(body) : null;

    const opts = {
      hostname:           parsed.hostname,
      port:               parsed.port || 5665,
      path:               parsed.pathname + parsed.search,
      method,
      rejectUnauthorized: false,
      headers: {
        Accept:        'application/json',
        Authorization: `Basic ${auth}`,
        ...(bodyData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyData) } : {}),
      },
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = { raw }; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
      });
    });

    req.setTimeout(10_000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (bodyData) req.write(bodyData);
    req.end();
  });
}

async function hostExists(name) {
  try {
    const r = await request('GET', `/objects/hosts/${encodeURIComponent(name)}`);
    return r.status === 200;
  } catch {
    return false;
  }
}

// Cria ou atualiza um host no Icinga2 via API REST.
// vars: objeto livre de variáveis Icinga (smtp_port, imap_port, etc.)
async function registerHost(name, address, displayName, vars = {}) {
  const exists = await hostExists(name);
  const mergedVars = { os: 'Linux', discovered: true, ...vars };

  const body = exists
    ? { attrs: { address, display_name: displayName || name, vars: mergedVars } }
    : {
        templates: ['generic-host'],
        attrs: {
          address,
          display_name: displayName || name,
          check_command: 'hostalive',
          vars: mergedVars,
        },
      };

  const r = await request(exists ? 'POST' : 'PUT', `/objects/hosts/${encodeURIComponent(name)}`, body);
  return { ok: r.ok, status: r.status, existed: exists, data: r.data };
}

// Remove host e seus serviços do Icinga2 (cascade).
async function removeHost(name) {
  const r = await request('DELETE', `/objects/hosts/${encodeURIComponent(name)}?cascade=1`);
  return { ok: r.ok, status: r.status, data: r.data };
}

// Reagenda um check de host ou serviço.
async function rescheduleCheck(host, service) {
  const filter = service
    ? `host.name=="${host}" && service.name=="${service}"`
    : `host.name=="${host}"`;
  const r = await request('POST', '/actions/reschedule-check', {
    type:   service ? 'Service' : 'Host',
    filter,
  });
  return { ok: r.ok, status: r.status, output: `reschedule HTTP ${r.status}` };
}

// Lista todos os hosts registrados no Icinga2.
async function listHosts() {
  const r = await request('GET', '/objects/hosts?attrs=address&attrs=display_name&attrs=vars&attrs=state');
  if (!r.ok) return [];
  return (r.data.results || []).map(h => ({
    name:         h.name,
    address:      h.attrs?.address,
    display_name: h.attrs?.display_name,
    state:        h.attrs?.state,
    vars:         h.attrs?.vars,
  }));
}

module.exports = { request, registerHost, removeHost, hostExists, rescheduleCheck, listHosts };
