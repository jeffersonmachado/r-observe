'use strict';

const dgram = require('dgram');
const { log } = require('../utils/logger');
const { isValidIPv4 } = require('../scanners/target-expansion');

function sanitizeText(value, maxLen = 1024) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function extractIp(text) {
  const m = String(text || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  if (!m) return null;
  return isValidIPv4(m[1]) ? m[1] : null;
}

function extractMac(text) {
  const m = String(text || '').match(/\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/i);
  return m ? m[1].toLowerCase() : null;
}

function baseEnrichment(type, source, payload = {}) {
  return {
    type,
    source,
    payload,
    assets: payload.asset_hints || [],
    topology: payload.topology_hints || [],
    fingerprints: payload.fingerprint_hints || [],
    history: {
      event_type: type,
      observed_at: new Date().toISOString(),
    },
  };
}

function parseSyslogMessage(msg) {
  const text = sanitizeText(msg, 2048);
  const low = text.toLowerCase();
  let type = 'syslog';
  if (low.includes('dhcp')) type = 'dhcp';
  else if (low.includes('mdns')) type = 'mdns';
  else if (low.includes('ssdp')) type = 'ssdp';
  else if (low.includes('lldp')) type = 'lldp';
  else if (low.includes('cdp')) type = 'cdp';
  else if (low.includes('snmp') && low.includes('trap')) type = 'snmp_trap';
  else if (low.includes('arp') && (low.includes('change') || low.includes('moved') || low.includes('updated'))) type = 'arp_change';

  const sourceIp = extractIp(text);
  const mac = extractMac(text);
  const hostname = (text.match(/\b([a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})+)\b/i) || [])[1] || null;

  return baseEnrichment(type, 'syslog', {
    message: text,
    raw: text,
    source_ip: sourceIp,
    mac,
    hostname,
    asset_hints: [{ ip: sourceIp, mac, hostname }],
    topology_hints: [],
    fingerprint_hints: [{ method: 'syslog', signature: text.slice(0, 180) }],
  });
}

function parseSsdpMessage(msg) {
  const raw = String(msg || '').trim();
  const text = sanitizeText(raw, 4096);
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  const headers = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    headers[key] = val;
  }
  return baseEnrichment('ssdp', 'ssdp', {
    message: text,
    st: headers.st || null,
    usn: headers.usn || null,
    server: headers.server || null,
    location: headers.location || null,
    cache_control: headers['cache-control'] || null,
    protocol: 'udp',
    asset_hints: [{ hostname: null, service: headers.st || null }],
    topology_hints: [],
    fingerprint_hints: [{ method: 'ssdp', signature: headers.server || headers.st || null }],
  });
}

function parseMdnsMessage(buf) {
  const text = Buffer.from(buf || []).toString('utf8').replace(/\0/g, '.');
  const raw = sanitizeText(text, 2048);
  const low = raw.toLowerCase();

  // Extrair hostname .local
  const host = (text.match(/([a-z0-9][a-z0-9-]*\.local)\b/i) || [])[1]?.toLowerCase() || null;

  // Detectar serviços mDNS anunciados no pacote
  const services = [];
  if (low.includes('_airplay'))           services.push('_airplay._tcp');
  if (low.includes('_googlecast'))        services.push('_googlecast._tcp');
  if (low.includes('_androidtvremote'))   services.push('_androidtvremote2._tcp');
  if (low.includes('_matter'))            services.push('_matter._tcp');
  if (low.includes('_companion-link'))    services.push('_companion-link._tcp');
  if (low.includes('_airdrop'))           services.push('_airdrop._tcp');
  if (low.includes('_raop'))              services.push('_raop._tcp');

  // Extrair chaves TXT (manufacturer, model, md=, fn=)
  const txtManufacturer = (raw.match(/manufacturer=([^\s]+)/i) || [])[1] || null;
  const txtModel        = (raw.match(/model=([^\s=]+(?:\s[^\s=]+)*?)(?=\s+\w+=|$)/i) || [])[1]?.trim() || null;
  const txtFriendlyName = (raw.match(/fn=([^\s=]+(?:\s[^\s=]+)*?)(?=\s+\w+=|$)/i) || [])[1]?.trim() || null;
  const txtMdModel      = (raw.match(/md=([^\s=]+(?:\s[^\s=]+)*?)(?=\s+\w+=|$)/i) || [])[1]?.trim() || null;

  const fingerprint_hints = [{ method: 'mdns', signature: host }];
  if (services.length) fingerprint_hints.push({ method: 'mdns-service', signature: services.join(',') });

  return {
    ...baseEnrichment('mdns', 'mdns', {
      raw: sanitizeText(raw, 1024),
      question_or_answer: host,
      protocol: 'udp',
      mdns_services: services,
      txt_manufacturer: txtManufacturer,
      txt_model: txtModel || txtMdModel,
      txt_friendly_name: txtFriendlyName,
      asset_hints: [{ hostname: host }],
      topology_hints: [],
      fingerprint_hints,
    }),
    hostname: host,
  };
}

function parseSnmpTrapMessage(buf) {
  const rawHex = Buffer.from(buf || []).toString('hex').slice(0, 2048);
  const text = Buffer.from(buf || []).toString('utf8');
  const normalized = text.replace(/[^\x20-\x7E]/g, ' ').trim().slice(0, 1024);
  return baseEnrichment('snmp_trap', 'snmp_trap', {
    raw_hex: rawHex,
    raw_text: normalized,
    protocol: 'udp',
    source_ip: extractIp(normalized),
    mac: extractMac(normalized),
    asset_hints: [{ ip: extractIp(normalized), mac: extractMac(normalized) }],
    topology_hints: [],
    fingerprint_hints: [{ method: 'snmp_trap', signature: normalized.slice(0, 180) }],
  });
}

function bindUdpServer({ port, host = '0.0.0.0', multicast, onMessage, label }) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  sock.on('error', (err) => {
    log('warn', 'Passive UDP listener error', { label, port, err: err.message });
  });

  sock.on('message', (msg, rinfo) => {
    try {
      onMessage(msg, rinfo);
    } catch (err) {
      log('warn', 'Passive UDP message handling failed', { label, port, err: err.message });
    }
  });

  sock.bind(port, host, () => {
    if (multicast) {
      try {
        sock.addMembership(multicast);
      } catch (err) {
        log('warn', 'Passive multicast join failed', { label, multicast, err: err.message });
      }
    }
    log('info', 'Passive UDP listener online', { label, bind: `${host}:${port}`, multicast: multicast || null });
  });

  return sock;
}

function startPassiveReceivers({ onEvent }) {
  const listeners = [];

  const syslogPort = parseInt(process.env.DISCOVERY_SYSLOG_PORT || '5514', 10);
  const trapPort = parseInt(process.env.DISCOVERY_SNMP_TRAP_PORT || '9162', 10);
  const mdnsPort = parseInt(process.env.DISCOVERY_MDNS_PORT || '5353', 10);
  const ssdpPort = parseInt(process.env.DISCOVERY_SSDP_PORT || '1900', 10);

  listeners.push(bindUdpServer({
    label: 'syslog',
    port: syslogPort,
    onMessage: (msg, rinfo) => {
      const evt = parseSyslogMessage(msg.toString('utf8'));
      onEvent({ ...evt, source_ip: rinfo.address, payload: { ...evt.payload, source_port: rinfo.port } });
    },
  }));

  listeners.push(bindUdpServer({
    label: 'snmp-trap',
    port: trapPort,
    onMessage: (msg, rinfo) => {
      const evt = parseSnmpTrapMessage(msg);
      onEvent({ ...evt, source_ip: rinfo.address, payload: { ...evt.payload, source_port: rinfo.port } });
    },
  }));

  listeners.push(bindUdpServer({
    label: 'mdns',
    port: mdnsPort,
    multicast: '224.0.0.251',
    onMessage: (msg, rinfo) => {
      const evt = parseMdnsMessage(msg);
      onEvent({ ...evt, source_ip: rinfo.address, payload: { ...evt.payload, source_port: rinfo.port } });
    },
  }));

  listeners.push(bindUdpServer({
    label: 'ssdp',
    port: ssdpPort,
    multicast: '239.255.255.250',
    onMessage: (msg, rinfo) => {
      const evt = parseSsdpMessage(msg.toString('utf8'));
      onEvent({ ...evt, source_ip: rinfo.address, payload: { ...evt.payload, source_port: rinfo.port } });
    },
  }));

  return () => {
    for (const sock of listeners) {
      try { sock.close(); } catch (_) {}
    }
  };
}

module.exports = {
  startPassiveReceivers,
  parseSyslogMessage,
  parseSsdpMessage,
  parseMdnsMessage,
  parseSnmpTrapMessage,
};
