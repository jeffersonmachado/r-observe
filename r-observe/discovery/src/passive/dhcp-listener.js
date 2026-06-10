'use strict';

// DHCP Passive Listener para R-Observe Discovery (Enterprise).
// Escuta trafego DHCP broadcast (porta 67) para descobrir dispositivos
// assim que eles solicitam IP via DHCP DISCOVER/REQUEST.
//
// Extrai: MAC address, hostname (option 12), vendor class (option 60),
// requested IP, e DHCP server IP. Permite descoberta instantanea
// de dispositivos que ainda nem tem IP atribuido.

const dgram = require('dgram');
const { log } = require('../utils/logger');
const { isValidIPv4 } = require('../scanners/target-expansion');

const DHCP_PORT = parseInt(process.env.DISCOVERY_DHCP_PORT || '67', 10);
const LISTEN_HOST = process.env.DISCOVERY_DHCP_BIND || '0.0.0.0';

// DHCP Message Types (RFC 2132, option 53)
const DHCP_TYPES = {
  1: 'DISCOVER',
  2: 'OFFER',
  3: 'REQUEST',
  4: 'DECLINE',
  5: 'ACK',
  6: 'NAK',
  7: 'RELEASE',
  8: 'INFORM',
};

// DHCP Options (RFC 2132)
const DHCP_OPTIONS = {
  1: 'subnet_mask',
  3: 'router',
  6: 'dns_server',
  12: 'hostname',
  15: 'domain_name',
  28: 'broadcast_address',
  50: 'requested_ip',
  51: 'lease_time',
  53: 'dhcp_message_type',
  54: 'dhcp_server',
  55: 'parameter_list',
  60: 'vendor_class',
  61: 'client_id',
  66: 'tftp_server',
  67: 'bootfile_name',
};

// Parse opcoes DHCP do payload binario.
function parseDhcpOptions(buf, start = 240) {
  // Magic cookie: 99, 130, 83, 99 (0x63825363)
  let offset = start;
  if (buf[offset] !== 0x63 || buf[offset + 1] !== 0x82 ||
      buf[offset + 2] !== 0x53 || buf[offset + 3] !== 0x63) {
    return {};
  }
  offset += 4;

  const options = {};
  while (offset < buf.length) {
    const code = buf[offset];
    if (code === 255) break; // END
    if (code === 0) { offset++; continue; } // PAD

    const len = buf[offset + 1] || 0;
    offset += 2;

    if (len === 0) continue;
    const value = buf.slice(offset, offset + len);

    const name = DHCP_OPTIONS[code] || `option_${code}`;

    // Interpretacao por tipo de option
    if (code === 53) {
      // DHCP Message Type (single byte)
      options.dhcp_message_type = DHCP_TYPES[value[0]] || `UNKNOWN(${value[0]})`;
    } else if (code === 50 || code === 54) {
      // IPv4 (4 bytes)
      if (value.length === 4) {
        options[name] = `${value[0]}.${value[1]}.${value[2]}.${value[3]}`;
      }
    } else if (code === 12 || code === 15 || code === 60) {
      // Texto (hostname, domain, vendor class)
      options[name] = value.toString('utf8').replace(/\0/g, '').trim();
    } else if (code === 55) {
      // Parameter request list (array de bytes)
      options[name] = Array.from(value);
    } else if (len === 4 && !isNaN(value.readUInt32BE(0))) {
      // Tenta interpretar como IP se 4 bytes
      options[name] = `${value[0]}.${value[1]}.${value[2]}.${value[3]}`;
    } else {
      options[name] = value.toString('hex');
    }

    offset += len;
  }

  return options;
}

// Extrai MAC address do campo chaddr (client hardware address).
function extractClientMac(buf) {
  // chaddr fica nos bytes 28-43 (16 bytes para hardware address)
  // htype=1 (Ethernet), hlen=6 → MAC nos primeiros 6 bytes de chaddr
  const htype = buf[1];
  const hlen = buf[2];

  if (htype === 1 && hlen === 6) {
    const mac = [];
    for (let i = 28; i < 28 + 6; i++) {
      mac.push(buf[i].toString(16).padStart(2, '0'));
    }
    return mac.join(':');
  }

  return null;
}

// Parse de um pacote DHCP completo.
function parseDhcpPacket(buf) {
  // Campos fixos do header DHCP
  const op = buf[0];     // 1=BOOTREQUEST, 2=BOOTREPLY
  const xid = buf.readUInt32BE(4);

  // IPs
  const ciaddr = `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;   // client IP
  const yiaddr = `${buf[16]}.${buf[17]}.${buf[18]}.${buf[19]}`;   // your IP (assigned)
  const siaddr = `${buf[20]}.${buf[21]}.${buf[22]}.${buf[23]}`;   // next server IP
  const giaddr = `${buf[24]}.${buf[25]}.${buf[26]}.${buf[27]}`;   // relay agent IP

  const clientMac = extractClientMac(buf);
  const options = parseDhcpOptions(buf);

  const messageType = options.dhcp_message_type || (op === 1 ? 'BOOTREQUEST' : 'BOOTREPLY');
  const hostname = options.hostname || null;
  const vendorClass = options.vendor_class || null;
  const requestedIp = options.requested_ip || null;
  const dhcpServer = options.dhcp_server || null;

  // Determinar o IP mais relevante do dispositivo
  let clientIp = null;
  if (isValidIPv4(ciaddr) && ciaddr !== '0.0.0.0') clientIp = ciaddr;
  if (messageType === 'ACK' && isValidIPv4(yiaddr) && yiaddr !== '0.0.0.0') clientIp = yiaddr;
  if (!clientIp && requestedIp && isValidIPv4(requestedIp)) clientIp = requestedIp;

  return {
    type: 'dhcp',
    source: 'dhcp-passive',
    message_type: messageType,
    client_mac: clientMac,
    client_ip: clientIp,
    hostname,
    vendor_class: vendorClass,
    requested_ip: requestedIp,
    dhcp_server: dhcpServer,
    relay_agent: isValidIPv4(giaddr) && giaddr !== '0.0.0.0' ? giaddr : null,
    transaction_id: xid,
    options,
    timestamp: new Date().toISOString(),
  };
}

// Detecta vendor/fabricante a partir do vendor class identifier (option 60).
function detectDeviceFromDhcp(parsed) {
  if (!parsed) return { device_type: 'host', vendor: null, os_hint: null };

  const vc = (parsed.vendor_class || '').toLowerCase();
  const hn = (parsed.hostname || '').toLowerCase();

  // Android
  if (vc.includes('android') || vc.includes('dhcpcd')) {
    return { device_type: 'mobile', vendor: 'Google', os_hint: 'Android' };
  }
  // iOS / macOS
  if (vc.includes('apple') || vc.includes('ios') || vc.includes('macos') || vc.includes('darwin')) {
    return { device_type: hn.includes('iphone') ? 'mobile' : 'host', vendor: 'Apple', os_hint: vc.includes('ios') ? 'iOS' : 'macOS' };
  }
  // Windows
  if (vc.includes('msft') || vc.includes('microsoft') || vc.includes('windows')) {
    return { device_type: 'host', vendor: 'Microsoft', os_hint: 'Windows' };
  }
  // Linux
  if (vc.includes('linux') || vc.includes('ubuntu') || vc.includes('debian') || vc.includes('fedora')) {
    return { device_type: 'host', vendor: null, os_hint: 'Linux' };
  }
  // Printers
  if (vc.includes('printer') || vc.includes('hp jet') || vc.includes('xerox') || vc.includes('canon') || vc.includes('epson') || vc.includes('brother')) {
    return { device_type: 'iot', vendor: detectPrinterVendor(vc), os_hint: null };
  }
  // VoIP phones
  if (vc.includes('sip') || vc.includes('yealink') || vc.includes('polycom') || vc.includes('grandstream') || vc.includes('cisco/spa')) {
    return { device_type: 'iot', vendor: detectVoipVendor(vc), os_hint: null };
  }
  // IoT / cameras
  if (vc.includes('hikvision') || vc.includes('dahua') || vc.includes('axis')) {
    return { device_type: 'iot', vendor: detectCameraVendor(vc), os_hint: null };
  }
  // Network gear
  if (vc.includes('cisco') || vc.includes('juniper') || vc.includes('aruba') || vc.includes('mikrotik') || vc.includes('ubiquiti')) {
    return { device_type: 'network_device', vendor: detectNetworkVendor(vc), os_hint: null };
  }

  return { device_type: 'host', vendor: null, os_hint: null };
}

function detectPrinterVendor(vc) {
  if (vc.includes('hp')) return 'HP';
  if (vc.includes('xerox')) return 'Xerox';
  if (vc.includes('canon')) return 'Canon';
  if (vc.includes('epson')) return 'Epson';
  if (vc.includes('brother')) return 'Brother';
  return null;
}

function detectVoipVendor(vc) {
  if (vc.includes('yealink')) return 'Yealink';
  if (vc.includes('polycom')) return 'Polycom';
  if (vc.includes('grandstream')) return 'Grandstream';
  if (vc.includes('cisco')) return 'Cisco';
  return null;
}

function detectCameraVendor(vc) {
  if (vc.includes('hikvision')) return 'Hikvision';
  if (vc.includes('dahua')) return 'Dahua';
  if (vc.includes('axis')) return 'Axis';
  return null;
}

function detectNetworkVendor(vc) {
  if (vc.includes('cisco')) return 'Cisco';
  if (vc.includes('juniper')) return 'Juniper';
  if (vc.includes('aruba')) return 'Aruba';
  if (vc.includes('mikrotik')) return 'MikroTik';
  if (vc.includes('ubiquiti')) return 'Ubiquiti';
  return null;
}

// Inicia o listener DHCP passivo.
// IMPORTANTE: requer CAP_NET_RAW ou root para bind na porta 67.
// Retorna funcao stop().
function startDhcpListener(onEvent) {
  let sock = null;

  try {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    sock.on('error', (err) => {
      if (err.code === 'EACCES' || err.code === 'EPERM') {
        log('warn', 'DHCP listener requires elevated privileges (CAP_NET_RAW or root). Disabled.', { err: err.message });
        try { sock.close(); } catch (_) {}
        sock = null;
        return;
      }
      log('warn', 'DHCP listener error', { err: err.message });
    });

    sock.on('message', (msg, rinfo) => {
      try {
        const parsed = parseDhcpPacket(msg);
        if (!parsed.client_mac) return; // so interessa pacotes com MAC

        const device = detectDeviceFromDhcp(parsed);

        onEvent({
          type: 'dhcp',
          source: 'dhcp-passive',
          source_ip: parsed.client_ip || parsed.requested_ip || rinfo.address,
          mac: parsed.client_mac,
          hostname: parsed.hostname,
          protocol: 'udp',
          payload: {
            ...parsed,
            port: 67,
            source_port: rinfo.port,
            device_type: device.device_type,
            vendor: device.vendor,
            os_hint: device.os_hint,
          },
        });
      } catch (err) {
        log('warn', 'DHCP packet parse failed', { err: err.message });
      }
    });

    sock.bind(DHCP_PORT, LISTEN_HOST, () => {
      log('info', 'DHCP passive listener online', { bind: `${LISTEN_HOST}:${DHCP_PORT}` });
    });

  } catch (e) {
    log('warn', 'DHCP listener startup failed', { err: e.message });
    return () => {};
  }

  return () => {
    if (sock) {
      try { sock.close(); } catch (_) {}
      log('info', 'DHCP listener stopped');
    }
  };
}

module.exports = { startDhcpListener, parseDhcpPacket, detectDeviceFromDhcp };
