'use strict';

const dgram = require('dgram');
const net = require('net');
const { reverseDns, tcpConnect, httpFingerprint, tlsCertificateFingerprint, faviconHash, readTcpBanner } = require('../utils/network');
const { resolveProfile } = require('../policies/profiles');
const { probeSnmpTarget } = require('./snmp-discovery');
const { deepProbe, probeToEvidence } = require('./deep-probe');
const kb = require('../knowledge/loader');

// Portas mínimas de fallback (sempre escaneadas mesmo sem knowledge base)
const FALLBACK_PORTS = [22, 53, 80, 443];

// Portas extras via env var (vírgula ou espaço)
function parseExtraPorts(envVar) {
  if (!envVar) return [];
  return envVar.split(/[,\s]+/).map(Number).filter(p => p > 0 && p <= 65535);
}

const EXTRA_PORTS = parseExtraPorts(process.env.DISCOVERY_EXTRA_PORTS);
const SCAN_MAX_PARALLEL = parseInt(process.env.DISCOVERY_SCAN_PARALLEL || '20', 10);

/**
 * Deriva portas a escanear de múltiplas fontes:
 * 1. Knowledge base (services.yml → todas as portas conhecidas)
 * 2. Profile (safe/balanced/aggressive → portas adicionais)
 * 3. Env var (DISCOVERY_EXTRA_PORTS → overrides manuais)
 * 4. Fallback (22, 53, 80, 443 → sempre)
 *
 * Nenhuma porta hardcoded — tudo vem de dados externalizados.
 */
function derivePorts(profile) {
  const ports = new Set(FALLBACK_PORTS);

  // Knowledge base: todas as portas de todos os serviços
  for (const svc of kb.getServices()) {
    for (const p of (svc.ports || [])) ports.add(p);
  }

  // Knowledge base: todas as portas dos port-hints
  for (const p of Object.keys(kb.getPortHints())) {
    ports.add(parseInt(p, 10));
  }

  // Profile ports
  for (const p of (profile.ports || [])) ports.add(p);

  // Env var overrides
  for (const p of EXTRA_PORTS) ports.add(p);

  return [...ports].sort((a, b) => a - b);
}

function parseHeaderBlock(text) {
  const headers = {};
  for (const line of String(text || '').split(/\r?\n/).slice(1)) {
    const idx = line.indexOf(':');
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function udpRequest(host, port, payload, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.once('message', (msg, rinfo) => finish({ payload: msg.toString('utf8'), remote: rinfo }));
    socket.once('error', () => finish(null));
    socket.send(Buffer.from(payload), port, host, (err) => {
      if (err) finish(null);
    });
  });
}

async function probeSipOptions(host, timeoutMs = 1800) {
  const branch = Math.random().toString(16).slice(2);
  const payload = [
    `OPTIONS sip:${host} SIP/2.0`,
    `Via: SIP/2.0/UDP r-observe.local;branch=z9hG4bK${branch}`,
    'Max-Forwards: 70',
    'From: <sip:r-observe@r-observe.local>;tag=scan',
    `To: <sip:${host}>`,
    `Call-ID: ${Date.now()}-${branch}@r-observe.local`,
    'CSeq: 1 OPTIONS',
    'Contact: <sip:r-observe@r-observe.local>',
    'User-Agent: r-observe-discovery',
    'Accept: application/sdp',
    'Content-Length: 0',
    '',
    '',
  ].join('\r\n');
  const resp = await udpRequest(host, 5060, payload, timeoutMs);
  if (!resp?.payload) return { responded: false, status: 'timeout' };
  const status = resp.payload.match(/^SIP\/2\.0\s+(\d{3})\s*([^\r\n]*)/i);
  const headers = parseHeaderBlock(resp.payload);
  return {
    responded: !!status,
    status: status ? Number(status[1]) : null,
    reason: status?.[2]?.trim() || null,
    server: headers.server || null,
    user_agent: headers['user-agent'] || headers.server || null,
    headers,
    raw: resp.payload.slice(0, 2048),
  };
}

function tcpRequest(host, port, payload, timeoutMs = 1800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let data = '';
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(value);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => sock.write(payload));
    sock.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 4096 || /\r\n\r\n/.test(data)) finish(data);
    });
    sock.once('timeout', () => finish(data || null));
    sock.once('error', () => finish(null));
    sock.connect(port, host);
  });
}

async function probeRtspOptions(host, timeoutMs = 1800) {
  const rtspVersion = 'RTSP/' + '1.0';
  const raw = await tcpRequest(host, 554, `OPTIONS rtsp://${host}/ ${rtspVersion}\r\nCSeq: 1\r\nUser-Agent: r-observe-discovery\r\n\r\n`, timeoutMs);
  if (!raw) return { responded: false, status: 'timeout' };
  const status = raw.match(/^RTSP\/1\.0\s+(\d{3})\s*([^\r\n]*)/i);
  const headers = parseHeaderBlock(raw);
  return {
    responded: !!status,
    status: status ? Number(status[1]) : null,
    reason: status?.[2]?.trim() || null,
    server: headers.server || null,
    headers,
    sdp: /\r\n\r\n([\s\S]+)/.exec(raw)?.[1]?.slice(0, 4096) || null,
    raw: raw.slice(0, 4096),
  };
}

async function probeOnvifWsDiscovery(host, timeoutMs = 2200) {
  const messageId = `uuid:${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = `<?xml version="1.0" encoding="UTF-8"?>
<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
  <e:Header>
    <w:MessageID>${messageId}</w:MessageID>
    <w:To>urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>
    <w:Action>http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action>
  </e:Header>
  <e:Body>
    <d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe>
  </e:Body>
</e:Envelope>`;
  const resp = await udpRequest(host, 3702, payload, timeoutMs);
  if (!resp?.payload) return { responded: false, status: 'timeout' };
  const xaddrs = [...resp.payload.matchAll(/<[^>]*XAddrs[^>]*>([^<]+)<\/[^>]*XAddrs>/gi)]
    .flatMap((m) => m[1].trim().split(/\s+/))
    .filter(Boolean);
  const scopesText = [...resp.payload.matchAll(/<[^>]*Scopes[^>]*>([^<]+)<\/[^>]*Scopes>/gi)].map((m) => m[1]).join(' ');
  const manufacturer = /(?:hardware|name|manufacturer)\/([^/\s]+)/i.exec(scopesText)?.[1] || null;
  const model = /(?:model)\/([^/\s]+)/i.exec(scopesText)?.[1] || null;
  return {
    responded: xaddrs.length > 0 || /ProbeMatches/i.test(resp.payload),
    xaddrs,
    manufacturer,
    model,
    device_info: !!(manufacturer || model),
    raw: resp.payload.slice(0, 4096),
  };
}

async function activeScanTarget(target, policy) {
  const profile = resolveProfile(policy.profile);

  // Portas: knowledge base + profile + env var + fallback
  const ports = derivePorts(profile);

  const open = [];
  const hostTimeoutMs = policy.host_timeout_ms || 12000;
  const started = Date.now();

  // ── Scan paralelo em batches ──────────────────────────────────────────
  const batchSize = Math.max(1, Math.min(SCAN_MAX_PARALLEL, 100));
  const portTimeoutMs = profile.timeoutMs || 1200;

  for (let i = 0; i < ports.length; i += batchSize) {
    if (Date.now() - started > hostTimeoutMs) break;

    const batch = ports.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(async (port) => {
      const ok = await tcpConnect(target.address, port, portTimeoutMs);
      return ok ? port : null;
    }));

    for (const port of results) {
      if (port !== null) open.push(port);
    }
  }

  const hostname = await reverseDns(target.address);
  const http = open.includes(80) ? await httpFingerprint(`${target.address}:80`, false) : null;
  const https = open.includes(443) ? await httpFingerprint(`${target.address}:443`, true) : null;
  const httpMeta = https || http;
  const tlsCert = open.includes(443) ? await tlsCertificateFingerprint(target.address, 443, Math.min(3000, hostTimeoutMs)) : null;
  const favHash = open.includes(80)
    ? await faviconHash(target.address, 80, false)
    : open.includes(443)
    ? await faviconHash(target.address, 443, true)
    : null;
  const sshBanner = open.includes(22) ? await readTcpBanner(target.address, 22, 1800) : null;
  const smtpBanner = (open.includes(25) || open.includes(587) || open.includes(465))
    ? await readTcpBanner(target.address, open.includes(25) ? 25 : open.includes(587) ? 587 : 465, 1800)
    : null;

  const probeTimeout = Math.min(2500, Math.max(800, profile.timeoutMs || 1800));
  const sipProbe = (open.includes(5060) || policy.allow_udp) ? await probeSipOptions(target.address, probeTimeout) : { responded: false, status: 'not_attempted' };
  const rtspProbe = open.includes(554) ? await probeRtspOptions(target.address, probeTimeout) : { responded: false, status: 'not_attempted' };
  const onvifProbe = (open.includes(3702) || open.includes(80) || open.includes(443) || open.includes(554))
    ? await probeOnvifWsDiscovery(target.address, probeTimeout)
    : { responded: false, status: 'not_attempted' };
  const sipUserAgent = sipProbe.responded ? (sipProbe.user_agent || sipProbe.server || null) : null;
  const rtspBanner = rtspProbe.responded ? [rtspProbe.status ? `RTSP ${rtspProbe.status}` : null, rtspProbe.server].filter(Boolean).join(' ') || null : null;
  const onvifModel = onvifProbe.responded ? (onvifProbe.model || onvifProbe.manufacturer || null) : null;
  const snmpData = open.includes(161) ? await probeSnmpTarget(target.address, { timeoutMs: Math.min(4000, hostTimeoutMs) }) : null;
  const snmpSysDescr = snmpData?.sysDescr || null;

  // ── Deep protocol probes ──────────────────────────────────────────────
  const deepProbes = [];
  if (process.env.DISCOVERY_DEEP_PROBE_ENABLED !== 'false') {
    const probePromises = open.map(async (port) => {
      const result = await deepProbe(target.address, port);
      return result ? { port, result } : null;
    });
    const probeResults = await Promise.all(probePromises);
    for (const r of probeResults) {
      if (r) deepProbes.push({ port: r.port, ...r.result });
    }
  }

  return {
    address: target.address,
    hostname,
    open_ports: open,
    http_server: httpMeta?.headers?.server || null,
    http_title: httpMeta?.title || null,
    tls_subject: tlsCert?.subject || null,
    tls_issuer: tlsCert?.issuer || null,
    tls_sha256: tlsCert?.sha256 || null,
    tls_valid_from: tlsCert?.valid_from || null,
    tls_valid_to: tlsCert?.valid_to || null,
    favicon_hash: favHash,
    ssh_banner: sshBanner,
    smtp_banner: smtpBanner,
    sip_user_agent: sipUserAgent,
    sip_probe: sipProbe,
    rtsp_banner: rtspBanner,
    rtsp_probe: rtspProbe,
    onvif_model: onvifModel,
    onvif_probe: onvifProbe,
    snmp_sysdescr: snmpSysDescr,
    snmp_sysname: snmpData?.sysName || null,
    snmp_uptime: snmpData?.sysUptime || null,
    snmp_neighbors: snmpData?.neighbors || [],
    snmp_interfaces: snmpData?.interfaces || [],
    snmp_vlans: snmpData?.vlans || [],
    deep_probes: deepProbes,
    protocols_detected: {
      arp: false,
      icmp: true,
      tcp_syn: false,
      tcp_connect: true,
      udp_controlled: !!policy.allow_udp,
      reverse_dns: !!hostname,
      snmp: !!snmpData,
      sip: !!sipProbe.responded,
      rtsp: !!rtspProbe.responded,
      onvif: !!onvifProbe.responded,
      mdns: false,
      ssdp: false,
      netbios: open.includes(137) || open.includes(139),
      docker_local: false,
    },
  };
}

module.exports = { activeScanTarget };
