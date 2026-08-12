'use strict';

/**
 * R-Observe Discovery — VoIP & Telephony Scanner (Enterprise)
 *
 * Detecta e classifica dispositivos de telefonia IP:
 *   - Asterisk / FreePBX / Issabel (AMI, SIP, HTTP)
 *   - Grandstream (SIP, HTTP, provisioning)
 *   - FreeSWITCH / FusionPBX (SIP, ESL)
 *   - 3CX (HTTP, SIP)
 *   - Yealink, Polycom, Cisco phones (SIP, HTTP, LLDP)
 *   - Dinstar, Khomp, Intelbras (SIP, SNMP)
 *
 * Cada descoberta retorna:
 *   - vendor, product, category
 *   - confidence_score (0.0 a 1.0)
 *   - evidence (array de evidências)
 *   - method (método de detecção)
 *   - timestamp
 */

const { log } = require('../utils/logger');

// ─── Constants ───────────────────────────────────────────────────────────────
const SIP_PORT = 5060;
const SIP_TLS_PORT = 5061;
const ASTERISK_AMI_PORT = 5038;
const FREESWITCH_ESL_PORT = 8021;

const VOIP_HTTP_PATHS = [
  '/admin',           // FreePBX, Issabel
  '/recordings',      // Asterisk
  '/api',             // Grandstream UCM
  '/management',      // 3CX
  '/fusionpbx',       // FusionPBX
  '/web',             // General
];

const DETECTION_METHODS = {
  SIP_BANNER: 'sip_banner',
  HTTP_HEADER: 'http_header',
  AMI_CONNECT: 'ami_connect',
  SNMP_SYSDESCR: 'snmp_sysdescr',
  NMAP_FINGERPRINT: 'nmap_fingerprint',
  HTTP_TITLE: 'http_title',
  SSL_CERTIFICATE: 'ssl_certificate',
  LLDP_CDP: 'lldp_cdp',
  MAC_OUI: 'mac_oui',
};

// ─── VoIP Device Signatures ──────────────────────────────────────────────────

const VOIP_SIGNATURES = {
  asterisk: {
    patterns: [/Asterisk/i, /asterisk/i],
    http_paths: ['/admin/config.php', '/recordings', '/static/config/js/pbx.js'],
    http_headers: ['FreePBX', 'Asterisk', 'PBX'],
    http_titles: ['FreePBX', 'Asterisk', 'Issabel', 'PBX Administration'],
    snmp_sysdescr: ['Asterisk', 'FreePBX'],
    sip_user_agents: ['Asterisk PBX', 'FPBX'],
    category: 'voice',
    technology: 'pbx',
    vendor: 'Asterisk/FreePBX',
  },
  grandstream_ucm: {
    patterns: [/Grandstream/i, /UCM\d+/i, /GXP\d+/i, /GXV\d+/i, /HT\d+/i],
    http_paths: ['/api', '/cgi-bin/api', '/cgi-bin'],
    http_headers: ['Grandstream', 'GS_'],
    http_titles: ['Grandstream', 'UCM', 'GXP', 'GXV'],
    snmp_sysdescr: ['Grandstream'],
    sip_user_agents: ['Grandstream'],
    mac_oui_prefixes: ['00:0B:82'],
    category: 'voice',
    technology: 'pbx',
    vendor: 'Grandstream',
  },
  freeswitch: {
    patterns: [/FreeSWITCH/i, /freeswitch/i, /FusionPBX/i],
    http_paths: ['/fusionpbx', '/app'],
    http_titles: ['FusionPBX', 'FreeSWITCH'],
    snmp_sysdescr: ['FreeSWITCH'],
    sip_user_agents: ['FreeSWITCH', 'FusionPBX'],
    category: 'voice',
    technology: 'pbx',
    vendor: 'FreeSWITCH',
  },
  '3cx': {
    patterns: [/3CX/i, /3cx/i],
    http_paths: ['/management', '/webclient'],
    http_headers: ['3CX'],
    http_titles: ['3CX', '3CX Phone System'],
    sip_user_agents: ['3CX', '3CXPhoneSystem'],
    category: 'voice',
    technology: 'pbx',
    vendor: '3CX',
  },
  yealink: {
    patterns: [/Yealink/i, /SIP-T\d+/i, /T4[0-9]S/i, /T5[0-9]W/i],
    http_titles: ['Yealink', 'IP Phone'],
    sip_user_agents: ['Yealink SIP'],
    mac_oui_prefixes: ['00:15:65', '80:5E:C0'],
    category: 'voice',
    technology: 'ip_phone',
    vendor: 'Yealink',
  },
  polycom: {
    patterns: [/Polycom/i, /SoundPoint/i, /SoundStation/i, /VVX/i, /Trio/i],
    sip_user_agents: ['Polycom'],
    mac_oui_prefixes: ['00:04:F2', '64:16:7F'],
    category: 'voice',
    technology: 'ip_phone',
    vendor: 'Polycom',
  },
  cisco_phone: {
    patterns: [/Cisco IP Phone/i, /Cisco SPA/i, /CP-/i],
    sip_user_agents: ['Cisco-CP'],
    mac_oui_prefixes: ['00:1A:E2', '00:1E:BE', '00:1E:F6', '70:CA:9B'],
    cdp_device: ['ciscoIPPhone', 'Cisco IP Phone'],
    category: 'voice',
    technology: 'ip_phone',
    vendor: 'Cisco',
  },
  dinstar: {
    patterns: [/Dinstar/i, /DAG\d+/i, /MTG\d+/i],
    snmp_sysdescr: ['Dinstar'],
    category: 'voice',
    technology: 'gateway',
    vendor: 'Dinstar',
  },
  khomp: {
    patterns: [/Khomp/i, /KGSM/i, /KE1[0-9]/i],
    snmp_sysdescr: ['Khomp'],
    category: 'voice',
    technology: 'gateway',
    vendor: 'Khomp',
  },
  intelbras_voip: {
    patterns: [/Intelbras/i, /TIPO/i, /VIP /i],
    snmp_sysdescr: ['Intelbras'],
    mac_oui_prefixes: ['00:1D:7E', '00:27:22', 'FC:AF:6A'],
    category: 'voice',
    technology: 'mixed',
    vendor: 'Intelbras',
  },
  sangoma: {
    patterns: [/Sangoma/i, /Vega/i],
    snmp_sysdescr: ['Sangoma'],
    category: 'voice',
    technology: 'gateway',
    vendor: 'Sangoma',
  },
};

// ─── Evidence Builder ────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function makeEvidence(type, source, confidence, data = {}) {
  return {
    evidence_type: type,
    evidence_source: source,
    confidence: Math.min(Math.max(confidence, 0), 1),
    raw_data: data.raw || null,
    normalized_data: data.normalized || {},
    timestamp: nowIso(),
  };
}

// ─── Signature Matcher ───────────────────────────────────────────────────────

function matchVoipSignature(signals) {
  const results = [];

  for (const [key, sig] of Object.entries(VOIP_SIGNATURES)) {
    let score = 0;
    let maxScore = 0;
    const evidence = [];

    // SIP User-Agent
    if (signals.sip_user_agent && sig.sip_user_agents) {
      maxScore += 3;
      for (const ua of sig.sip_user_agents) {
        if (String(signals.sip_user_agent).toLowerCase().includes(ua.toLowerCase())) {
          score += 3;
          evidence.push(makeEvidence(DETECTION_METHODS.SIP_BANNER, 'voip-scanner', 0.9, {
            raw: signals.sip_user_agent,
            normalized: { user_agent: ua, detected_vendor: sig.vendor },
          }));
          break;
        }
      }
    }

    // HTTP Server Header
    if (signals.http_server && sig.http_headers) {
      maxScore += 2;
      for (const h of sig.http_headers) {
        if (String(signals.http_server).toLowerCase().includes(h.toLowerCase())) {
          score += 2;
          evidence.push(makeEvidence(DETECTION_METHODS.HTTP_HEADER, 'voip-scanner', 0.8, {
            raw: signals.http_server,
            normalized: { header: h, detected_vendor: sig.vendor },
          }));
          break;
        }
      }
    }

    // HTTP Title
    if (signals.http_title && sig.http_titles) {
      maxScore += 2;
      for (const t of sig.http_titles) {
        if (String(signals.http_title).toLowerCase().includes(t.toLowerCase())) {
          score += 2;
          evidence.push(makeEvidence(DETECTION_METHODS.HTTP_TITLE, 'voip-scanner', 0.85, {
            raw: signals.http_title,
            normalized: { title_match: t, detected_vendor: sig.vendor },
          }));
          break;
        }
      }
    }

    // SNMP sysDescr
    if (signals.snmp_sysdescr && sig.snmp_sysdescr) {
      maxScore += 2;
      for (const d of sig.snmp_sysdescr) {
        if (String(signals.snmp_sysdescr).toLowerCase().includes(d.toLowerCase())) {
          score += 2;
          evidence.push(makeEvidence(DETECTION_METHODS.SNMP_SYSDESCR, 'voip-scanner', 0.75, {
            raw: signals.snmp_sysdescr,
            normalized: { sysdescr_match: d, detected_vendor: sig.vendor },
          }));
          break;
        }
      }
    }

    // MAC OUI
    if (signals.mac_address && sig.mac_oui_prefixes) {
      maxScore += 2;
      const macPrefix = String(signals.mac_address).toUpperCase().slice(0, 8);
      for (const oui of sig.mac_oui_prefixes) {
        if (macPrefix.startsWith(oui.toUpperCase())) {
          score += 2;
          evidence.push(makeEvidence(DETECTION_METHODS.MAC_OUI, 'voip-scanner', 0.7, {
            raw: signals.mac_address,
            normalized: { oui_match: oui, detected_vendor: sig.vendor },
          }));
          break;
        }
      }
    }

    // Pattern match on combined text
    if (sig.patterns) {
      maxScore += 1;
      const combined = [
        signals.sip_user_agent, signals.http_server, signals.http_title,
        signals.snmp_sysdescr, signals.hostname,
      ].filter(Boolean).join(' ');

      for (const re of sig.patterns) {
        if (re.test(combined)) {
          score += 1;
          evidence.push(makeEvidence('pattern_match', 'voip-scanner', 0.6, {
            raw: combined.slice(0, 200),
            normalized: { pattern: re.toString(), detected_vendor: sig.vendor },
          }));
          break;
        }
      }
    }

    if (score > 0 && maxScore > 0) {
      const confidence = Math.round((score / maxScore) * 100) / 100;
      results.push({
        vendor: sig.vendor,
        product: key,
        category: sig.category,
        technology: sig.technology,
        detection_method: evidence.map(e => e.evidence_source).join(', '),
        confidence_score: confidence,
        evidence,
        timestamp: nowIso(),
      });
    }
  }

  // Sort by confidence desc
  return results.sort((a, b) => b.confidence_score - a.confidence_score);
}

// ─── SIP Probe ───────────────────────────────────────────────────────────────

async function probeSip(host, port = SIP_PORT, timeout = 3000) {
  const net = require('net');
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    const result = { open: false, banner: null, error: null };

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      result.open = true;
      // Send OPTIONS to elicit SIP response
      const fromTag = Math.random().toString(36).slice(2, 10);
      const callId = Math.random().toString(36).slice(2, 20);
      const optionsReq = [
        `OPTIONS sip:${host}:${port} SIP/2.0`,
        `Via: SIP/2.0/UDP ${host}:${port};branch=z9hG4bK-${Math.random().toString(36).slice(2)}`,
        `From: <sip:scanner@${host}>;tag=${fromTag}`,
        `To: <sip:${host}>`,
        `Call-ID: ${callId}@${host}`,
        'CSeq: 1 OPTIONS',
        'Contact: <sip:scanner@scanner>',
        'Accept: application/sdp',
        'Content-Length: 0',
        '', '',
      ].join('\r\n');
      socket.write(optionsReq);
    });

    socket.on('data', (data) => {
      result.banner = data.toString().slice(0, 1024);
      socket.destroy();
    });

    socket.on('timeout', () => { socket.destroy(); });
    socket.on('error', (err) => { result.error = err.message; socket.destroy(); });
    socket.on('close', () => {
      if (!resolved) { resolved = true; resolve(result); }
    });

    socket.connect(port, host);
  });
}

// ─── HTTP Probe for VoIP ─────────────────────────────────────────────────────

async function probeVoipHttp(host, port = 80) {
  const results = [];
  for (const path of VOIP_HTTP_PATHS) {
    try {
      const url = `http://${host}:${port}${path}`;
      const resp = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(3000),
      });

      let body = '';
      if (resp.status < 400) {
        try {
          body = await resp.text();
          body = body.slice(0, 2000);
        } catch (_) {}
      }

      results.push({
        path,
        status: resp.status,
        server: resp.headers.get('server'),
        title: extractTitle(body),
        body_sample: body.slice(0, 500),
      });
    } catch (_) {
      // Path not responding, skip
    }
  }
  return results;
}

function extractTitle(html) {
  const match = String(html || '').match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 200) : null;
}

// ─── Main Discovery Function ─────────────────────────────────────────────────

/**
 * @param {object} input
 *   - ip: string (IP do host)
 *   - port: number (porta SIP, default 5060)
 *   - http_port: number (porta HTTP, default 80)
 *   - snmp_sysdescr: string (sysDescr SNMP, opcional)
 *   - mac_address: string (MAC address, opcional)
 *   - hostname: string (hostname, opcional)
 * @returns {object}
 *   - matches: array de matches com confidence_score
 *   - raw_signals: sinais coletados
 *   - timestamp
 */
async function discoverVoip(input = {}) {
  const ip = input.ip || input.address;
  if (!ip) return { matches: [], raw_signals: {}, timestamp: nowIso() };

  const sipPort = input.port || SIP_PORT;
  const httpPort = input.http_port || 80;
  const httpsPort = input.https_port || 443;

  const signals = {
    sip_user_agent: null,
    sip_banner: null,
    http_server: null,
    http_title: null,
    snmp_sysdescr: input.snmp_sysdescr || null,
    mac_address: input.mac_address || null,
    hostname: input.hostname || null,
  };

  // SIP probe
  const sipResult = await probeSip(ip, sipPort, 3000);
  if (sipResult.open && sipResult.banner) {
    signals.sip_banner = sipResult.banner;

    // Extract User-Agent from SIP response
    const uaMatch = sipResult.banner.match(/^(?:User-Agent|Server):\s*(.+)$/im);
    if (uaMatch) {
      signals.sip_user_agent = uaMatch[1].trim();
    }
  }

  // HTTP probe
  const httpResults = await probeVoipHttp(ip, httpPort);
  for (const r of httpResults) {
    if (r.server && !signals.http_server) signals.http_server = r.server;
    if (r.title && !signals.http_title) signals.http_title = r.title;
  }

  // Also try HTTPS if no HTTP found
  if (!signals.http_server && !signals.http_title) {
    try {
      const resp = await fetch(`https://${ip}:${httpsPort}/`, {
        signal: AbortSignal.timeout(3000),
        redirect: 'manual',
      });
      signals.http_server = resp.headers.get('server');
    } catch (_) {}
  }

  // Match signatures
  const matches = matchVoipSignature(signals);

  return {
    matches,
    raw_signals: signals,
    timestamp: nowIso(),
    ip,
  };
}

module.exports = {
  discoverVoip,
  matchVoipSignature,
  VOIP_SIGNATURES,
  DETECTION_METHODS,
  probeSip,
};
