'use strict';

function extractIp(text) {
  const m = String(text || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : null;
}

function extractHostname(text) {
  const m = String(text || '').match(/\b([a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{1,63})+)\b/i);
  if (!m) return null;
  // Rejeitar valores puramente numéricos (versões de protocolo como "1.1", "1.0", IPs parciais)
  if (/^\d+(\.\d+)+$/.test(m[1])) return null;
  return m[1].toLowerCase();
}

function extractMac(text) {
  const m = String(text || '').match(/\b([0-9a-f]{2}(?::[0-9a-f]{2}){5})\b/i);
  return m ? m[1].toLowerCase() : null;
}

function inferType(evt) {
  if (evt.type) return String(evt.type).toLowerCase();
  const source = String(evt.source || '').toLowerCase();
  if (source.includes('syslog')) return 'syslog';
  if (source.includes('mdns')) return 'mdns';
  if (source.includes('ssdp')) return 'ssdp';
  if (source.includes('snmp')) return 'snmp_trap';
  if (source.includes('lldp')) return 'lldp';
  if (source.includes('cdp')) return 'cdp';
  if (source.includes('dhcp')) return 'dhcp';
  if (source.includes('arp')) return 'arp_change';
  return 'passive_signal';
}

function normalizePayload(payload) {
  if (!payload) return {};
  if (typeof payload === 'object') return payload;
  if (typeof payload === 'string') return { message: payload };
  return {};
}

function normalizePassiveEvent(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const payload = normalizePayload(evt.payload);
  const rawText = [evt.message, payload.message, payload.raw, payload.line].filter(Boolean).join(' ');
  const sourceIp = evt.source_ip || payload.source_ip || payload.ip || extractIp(rawText) || null;
  const hostname = evt.hostname || evt.http_host || evt.tls_sni || payload.hostname || extractHostname(rawText) || null;
  const mac = evt.mac || payload.mac || extractMac(rawText) || null;

  return {
    type: inferType(evt),
    source: evt.source || null,
    source_ip: sourceIp,
    dest_ip: evt.dest_ip || payload.dest_ip || null,
    hostname,
    mac,
    protocol: evt.protocol || payload.protocol || null,
    payload,
    seen_at: new Date().toISOString(),
  };
}

module.exports = { normalizePassiveEvent };
