'use strict';

/**
 * ARP Normalizer — transforma resultados brutos de ARP/Nmap ping em
 * objetos de evidência padronizados para o motor de inferência.
 *
 * Entrada: resultado do arp-discovery.js ou nmap -sn
 * Saída:   normalized_asset pronto para o inference engine
 */

const { normalizeMac, analyzeMacType, vendorReliability } = require('../utils/mac-utils');
const { lookupMacVendor } = require('../fingerprint/oui');
const { debug, debugObject, isDebug } = require('../utils/logger');

/**
 * Normaliza um asset descoberto por ARP.
 *
 * @param {object} raw - asset bruto do arp-discovery (ip, mac, vendor, device, etc.)
 * @param {object} options
 * @param {boolean} options.isGateway - se o IP é default gateway
 * @param {boolean} options.isLocalhost - se o IP é a máquina local
 * @returns {object} asset normalizado
 */
function normalizeArpAsset(raw, options = {}) {
  const mac = normalizeMac(raw.mac_address || raw.mac || null);
  const macAnalysis = mac ? analyzeMacType(mac) : null;
  const rawVendor = raw.vendor || raw.mac_vendor || null;

  // Re-lookup via OUI database para garantir consistência
  const ouiVendor = mac ? lookupMacVendor(mac) : null;
  const vendor = ouiVendor || rawVendor || null;

  const reliability = mac ? vendorReliability(mac, vendor) : {
    vendor_reliable: false,
    mac_type: 'unknown',
    reason: 'No MAC address available',
  };

  if (isDebug()) {
    debug(`normalize:arp ip=${raw.primary_ip || raw.ip}`, {
      mac,
      mac_type: reliability.mac_type,
      vendor,
      vendor_reliable: reliability.vendor_reliable,
      oui_vendor: ouiVendor,
      raw_vendor: rawVendor,
      is_gateway: !!options.isGateway,
      is_localhost: !!options.isLocalhost,
    });
  }

  const evidence = [];

  // Evidência de ARP
  evidence.push({
    evidence_type: 'arp_discovery',
    evidence_source: raw.discovery_method || 'arp',
    confidence: mac ? 0.85 : 0.60,
    raw_data: { ip: raw.primary_ip || raw.ip, mac, device: raw.device || raw.last_seen_on_device },
    normalized_data: {
      ip: raw.primary_ip || raw.ip,
      mac,
      device: raw.device || raw.last_seen_on_device,
    },
  });

  // Evidência de MAC type
  if (macAnalysis) {
    evidence.push({
      evidence_type: 'mac_structure',
      evidence_source: 'mac-analysis',
      confidence: 0.95,
      raw_data: { mac, first_octet: macAnalysis.first_octet },
      normalized_data: {
        mac_type: macAnalysis.mac_type,
        is_locally_administered: macAnalysis.is_locally_administered,
        is_multicast: macAnalysis.is_multicast,
        is_global_unicast: macAnalysis.is_global_unicast,
      },
    });
  }

  // Evidência de vendor (com flag de confiabilidade)
  if (vendor) {
    evidence.push({
      evidence_type: 'vendor_identity',
      evidence_source: ouiVendor ? 'oui-database' : 'arp-metadata',
      confidence: reliability.vendor_reliable ? 0.74 : 0.20,
      raw_data: { mac, vendor, vendor_reliable: reliability.vendor_reliable },
      normalized_data: {
        vendor,
        vendor_reliable: reliability.vendor_reliable,
        mac_type: reliability.mac_type,
      },
    });
  } else {
    // Vendor desconhecido — registrar como evidência de baixa confiança
    evidence.push({
      evidence_type: 'vendor_identity',
      evidence_source: 'oui-database',
      confidence: 0.05,
      raw_data: { mac, vendor: null },
      normalized_data: {
        vendor: 'Unknown',
        vendor_reliable: false,
        mac_type: reliability.mac_type,
        reason: reliability.reason,
      },
    });
  }

  // Gateway evidence
  if (options.isGateway) {
    evidence.push({
      evidence_type: 'topology_context',
      evidence_source: 'gateway-detector',
      confidence: 0.95,
      raw_data: { ip: raw.primary_ip || raw.ip, role: 'default_gateway' },
      normalized_data: {
        topology_flags: ['gateway'],
        role: 'default_gateway',
      },
    });
  }

  // Localhost evidence
  if (options.isLocalhost) {
    evidence.push({
      evidence_type: 'topology_context',
      evidence_source: 'localhost-detector',
      confidence: 0.99,
      raw_data: { ip: raw.primary_ip || raw.ip, role: 'scanner' },
      normalized_data: {
        topology_flags: ['localhost'],
        role: 'scanner',
      },
    });
  }

  return {
    ip: raw.primary_ip || raw.ip,
    mac,
    vendor: vendor || 'Unknown',
    vendor_reliable: reliability.vendor_reliable,
    mac_type: reliability.mac_type,
    hostname: raw.hostname || raw.device_name || raw.device || null,
    is_gateway: !!options.isGateway,
    is_localhost: !!options.isLocalhost,
    open_ports: [],
    filtered_ports: [],
    asset_type: null, // será preenchido pelo inference engine
    possible_stack: null,
    confidence: null,
    evidence,
    _raw: raw,
  };
}

/**
 * Normaliza resultados de Nmap port scan.
 *
 * @param {object} scan - resultado do active scan (open_ports, hostname, banners, etc.)
 * @param {object} normalizedArp - asset já normalizado da etapa ARP (opcional)
 * @returns {object} merge dos dados de scan com o asset ARP
 */
function normalizeNmapScan(scan, normalizedArp) {
  const base = normalizedArp ? { ...normalizedArp } : {
    ip: scan.address || scan.ip,
    mac: null,
    vendor: 'Unknown',
    vendor_reliable: false,
    mac_type: 'unknown',
    hostname: scan.hostname || null,
    is_gateway: false,
    is_localhost: false,
    open_ports: [],
    filtered_ports: [],
    evidence: [],
    _raw: scan,
  };

  // Classificar portas por estado
  const allPorts = scan.ports || scan.open_ports || [];
  const openPorts = [];
  const filteredPorts = [];

  for (const p of allPorts) {
    const port = typeof p === 'number' ? p : (p.port || p);
    const entry = typeof p === 'number'
      ? { port, protocol: 'tcp', service: null, state: 'open' }
      : { port: p.port || port, protocol: p.protocol || 'tcp', service: p.service || null, state: p.state || 'open' };

    if (entry.state === 'filtered') {
      filteredPorts.push(entry);
    } else {
      openPorts.push(entry);
    }
  }

  base.open_ports = [...(base.open_ports || []), ...openPorts];
  base.filtered_ports = [...(base.filtered_ports || []), ...filteredPorts];

  // Atualiza hostname se disponível
  if (scan.hostname && !base.hostname) {
    base.hostname = scan.hostname;
  }

  if (isDebug()) {
    debug(`normalize:nmap ip=${base.ip}`, {
      open_ports: openPorts.map(p => `${p.port}/${p.protocol}`),
      filtered_ports: filteredPorts.map(p => `${p.port}/${p.protocol}`),
      hostname: base.hostname,
      distance: scan.distance,
      os_hint: scan.os_hint || null,
    });
  }

  // ── Banners e fingerprints (HTTP, SSH, SNMP, TLS) ──────────────────────
  base.http_server   = scan.http_server   || base.http_server   || null;
  base.http_title    = scan.http_title    || base.http_title    || null;
  base.ssh_banner    = scan.ssh_banner    || base.ssh_banner    || null;
  base.smtp_banner   = scan.smtp_banner   || base.smtp_banner   || null;
  base.snmp_sysdescr = scan.snmp_sysdescr || base.snmp_sysdescr || null;
  base.tls_subject   = scan.tls_subject   || base.tls_subject   || null;
  base.tls_issuer    = scan.tls_issuer    || base.tls_issuer    || null;
  base.os_hint       = scan.os_hint       || base.os_hint       || null;

  // NÃO criar evidências individuais de porta aqui — o inference engine
  // faz isso em extractPortEvidence com os PORT_HINTS adequados.
  // Apenas registrar uma evidência agregada de que houve port scan.

  if (openPorts.length > 0 || filteredPorts.length > 0) {
    base.evidence.push({
      evidence_type: 'port_scan_completed',
      evidence_source: 'nmap-scan',
      confidence: 0.85,
      raw_data: { open_count: openPorts.length, filtered_count: filteredPorts.length },
      normalized_data: {
        open_count: openPorts.length,
        filtered_count: filteredPorts.length,
      },
    });
  }

  // OS detection evidence
  if (scan.os_hint || scan.os_match) {
    base.evidence.push({
      evidence_type: 'os_detection',
      evidence_source: 'nmap-os',
      confidence: scan.os_confidence || 0.50,
      raw_data: { os_hint: scan.os_hint, os_match: scan.os_match },
      normalized_data: {
        os_hint: scan.os_hint || scan.os_match,
        os_confidence: scan.os_confidence || 0.50,
      },
    });
  }

  // Network distance
  if (scan.distance != null) {
    base.evidence.push({
      evidence_type: 'network_distance',
      evidence_source: 'nmap-scan',
      confidence: 0.40,
      raw_data: { distance: scan.distance },
      normalized_data: {
        distance: scan.distance,
        network_proximity: scan.distance <= 1 ? 'local' : 'remote',
      },
    });
  }

  // HTTP server header
  if (scan.http_server) {
    base.evidence.push({
      evidence_type: 'http_header',
      evidence_source: 'active-http',
      confidence: 0.70,
      raw_data: scan.http_server,
      normalized_data: {
        server: scan.http_server,
      },
    });
  }

  // TLS certificate
  if (scan.tls_subject) {
    base.evidence.push({
      evidence_type: 'tls_certificate',
      evidence_source: 'active-tls',
      confidence: 0.66,
      raw_data: { subject: scan.tls_subject, issuer: scan.tls_issuer },
      normalized_data: {
        subject: scan.tls_subject,
        issuer: scan.tls_issuer || null,
      },
    });
  }

  return base;
}

/**
 * Normaliza um asset completo combinando ARP + Nmap scan.
 *
 * @param {object} arpRaw - resultado bruto do ARP
 * @param {object} scanResult - resultado do active scan
 * @param {object} options - { isGateway, isLocalhost }
 * @returns {object} asset completamente normalizado
 */
function normalizeAsset(arpRaw, scanResult, options = {}) {
  const arpNorm = arpRaw ? normalizeArpAsset(arpRaw, options) : null;
  const merged = normalizeNmapScan(scanResult || {}, arpNorm);

  // Se não tem ARP, aplicar gateway/localhost diretamente no merged
  if (!arpRaw) {
    if (options.isGateway) {
      merged.is_gateway = true;
      merged.evidence.push({
        evidence_type: 'topology_context',
        evidence_source: 'gateway-detector',
        confidence: 0.95,
        raw_data: { ip: merged.ip, role: 'default_gateway' },
        normalized_data: { topology_flags: ['gateway'], role: 'default_gateway' },
      });
    }
    if (options.isLocalhost) {
      merged.is_localhost = true;
      merged.evidence.push({
        evidence_type: 'topology_context',
        evidence_source: 'localhost-detector',
        confidence: 0.99,
        raw_data: { ip: merged.ip, role: 'scanner' },
        normalized_data: { topology_flags: ['localhost'], role: 'scanner' },
      });
    }
  }

  // Se não tem MAC mas temos scan, o asset ainda é válido
  merged.ip = merged.ip || scanResult?.address || arpRaw?.primary_ip || 'unknown';
  merged.evidence.push({
    evidence_type: 'host_alive',
    evidence_source: 'combined',
    confidence: 0.90,
    raw_data: { ip: merged.ip },
    normalized_data: { alive: true },
  });

  if (isDebug()) {
    debug(`normalize:done ip=${merged.ip}`, {
      evidence_count: merged.evidence.length,
      open_ports: (merged.open_ports || []).length,
      filtered_ports: (merged.filtered_ports || []).length,
      is_gateway: merged.is_gateway,
      is_localhost: merged.is_localhost,
      mac_type: merged.mac_type,
      vendor_reliable: merged.vendor_reliable,
    });
  }

  return merged;
}

module.exports = {
  normalizeArpAsset,
  normalizeNmapScan,
  normalizeAsset,
};
