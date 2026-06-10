'use strict';

// Windows / SMB / NetBIOS Discovery Scanner para R-Observe Discovery (Enterprise).
// Descobre hosts Windows via:
// 1. SMB protocol detection (porta 445) - OS version, hostname, domain
// 2. NetBIOS name service (porta 137 UDP) - hostname, workgroup, MAC
// 3. RDP detection (porta 3389) - Windows indicator
// 4. WinRM / WS-Man (porta 5985/5986) - Windows management

const dgram = require('dgram');
const net = require('net');
const { log } = require('../utils/logger');

// SMB protocol negotiation (porta 445 TCP).
// Envia SMB negotiate request e extrai OS version, hostname, domain do response.
async function probeSmb(host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    let buffer = Buffer.alloc(0);

    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };

    sock.setTimeout(timeoutMs);

    sock.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      // SMB negotiate response packet
      if (buffer.length >= 4) {
        try {
          const result = parseSmbNegotiate(buffer);
          finish(result);
        } catch {
          // Wait for more data
          if (buffer.length > 4096) finish(null);
        }
      }
    });

    sock.on('connect', () => {
      // SMBv2 negotiate request
      const negotiate = buildSmb2Negotiate();
      sock.write(negotiate);
    });

    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));

    sock.connect(445, host);
  });
}

// Constroi SMB2 negotiate request packet.
function buildSmb2Negotiate() {
  // SMB2 header (64 bytes) + negotiate request
  const header = Buffer.alloc(64, 0);
  header.write('\xfeSMB', 0);           // Protocol ID
  header.writeUInt32LE(64, 4);           // Structure size
  // CreditCharge(2) + Reserved(2) + ChannelSequence(2) + Reserved(2)
  // Command = 0 (NEGOTIATE)
  header.writeUInt16LE(0, 12);           // Command: NEGOTIATE
  header.writeUInt32LE(0, 24);           // Status
  header.writeUInt32LE(0x424d53ff, 0);   // Protocol

  // Simpler: just send raw SMB negotiate bytes
  const negotiate = Buffer.from(
    '000000' + // NetBIOS session (length)
    'ff534d4272000000001801c0000000000000000000000000000000fffe000000000000000000000000000000000000000000000000000000000000' +
    // dialect count + dialects
    '0000000002000202',
    'hex'
  );

  // Corrige o NetBIOS length (primeiros 3 bytes)
  const nbssLen = negotiate.length - 4;
  negotiate.writeUIntBE(nbssLen, 0, 3);

  return negotiate;
}

// Parse SMB negotiate response.
function parseSmbNegotiate(buf) {
  if (buf.length < 4) return null;

  // Pula NetBIOS header (4 bytes)
  const smb = buf.slice(4);
  if (smb.length < 64) return null;

  const protocol = smb.slice(1, 5).toString();
  if (protocol !== 'SMB ') { // SMBv1
    // Tenta SMBv2
    if (smb.readUInt32LE(0) !== 0x424d53fe) return null; // not SMB
  }

  // Extrai dados do negotiate response
  const result = {
    protocol: 'smb',
    os_version: null,
    hostname: null,
    domain: null,
    smb_dialect: null,
  };

  // Tenta extrair strings do pacote (ASCII e UTF-16LE)
  const text = smb.toString('utf8').replace(/[^\x20-\x7E]/g, ' ');
  const wideText = smb.toString('utf16le').replace(/[^\x20-\x7E]/g, ' ');

  // Hostname e domain comuns em SMB negotiate
  const hostMatch = text.match(/([A-Za-z0-9_-]{1,15})\s+(WORKGROUP|[A-Za-z0-9_-]{1,15})/);
  if (hostMatch) {
    result.hostname = hostMatch[1];
    result.domain = hostMatch[2];
  }

  // OS version string: "Windows 10", "Windows Server 2019", etc.
  const osMatch = text.match(/(Windows\s+(?:Server\s+)?(?:\d+\.?\d*\s*(?:R2)?))/i);
  if (osMatch) result.os_version = osMatch[1];

  // SMB dialect
  const dialectMatch = text.match(/SMB\s*(2\.\d+|3\.\d+|3\.1\.1)/i);
  if (dialectMatch) result.smb_dialect = 'SMB ' + dialectMatch[1];

  return result.protocol === 'smb' && (result.os_version || result.hostname) ? result : null;
}

// NetBIOS Name Service probe (porta 137 UDP).
// Envia NBNS query para obter hostname e workgroup.
function probeNetbios(host, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    sock.on('message', (msg) => {
      if (msg.length < 12) return finish(null);

      const nameCount = msg.readUInt8(6);
      const answers = [];

      // NBNS response: names estao nos primeiros bytes
      for (let i = 0; i < Math.min(nameCount, 3); i++) {
        const offset = 57 + i * 18;
        if (offset + 18 > msg.length) break;

        const nameBytes = msg.slice(offset, offset + 16);
        const name = decodeNbnsName(nameBytes);
        if (name) {
          const flags = msg.readUInt16BE(offset + 16);
          const nameType = flags & 0x6000;
          const typeStr = nameType === 0x0000 ? '<workstation>' :
                          nameType === 0x2000 ? '<messenger>' :
                          nameType === 0x4000 ? '<domain master>' :
                          nameType === 0x6000 ? '<domain controller>' : '<unknown>';
          answers.push({ name, type: typeStr });
        }
      }

      if (answers.length > 0) {
        resolve({ protocol: 'netbios-ns', names: answers, source: 'nbns-probe' });
      } else {
        finish(null);
      }
    });

    sock.on('error', () => finish(null));

    // NBNS query: pergunta por * (wildcard name)
    const query = buildNbnsQuery('*');
    sock.send(query, 137, host, (err) => {
      if (err) finish(null);
    });
  });
}

// Constroi query NBNS para um nome.
function buildNbnsQuery(name) {
  // Header: Transaction ID(2) + Flags(2) + Questions(2) + Answers(2) + Authority(2) + Additional(2)
  const header = Buffer.alloc(12);
  header.writeUInt16BE(Math.floor(Math.random() * 65535), 0); // Transaction ID
  header.writeUInt16BE(0x0110, 2);  // Flags: query, broadcast
  header.writeUInt16BE(1, 4);        // Questions: 1

  // Question: encoded name (32 bytes) + Type(2) + Class(2)
  const encoded = encodeNbnsName(name);
  const question = Buffer.alloc(4);
  question.writeUInt16BE(0x0021, 0); // Type: NB (NetBIOS)
  question.writeUInt16BE(0x0001, 2); // Class: IN

  return Buffer.concat([header, encoded, question]);
}

function encodeNbnsName(name) {
  const encoded = Buffer.alloc(32, 0);
  const padded = (name + '*').padEnd(16, ' ').slice(0, 16).toUpperCase();
  // First level encoding: cada byte -> 2 bytes (upper nibble + 'A', lower nibble + 'A')
  for (let i = 0; i < 16; i++) {
    const code = padded.charCodeAt(i);
    encoded[i * 2] = 'A'.charCodeAt(0) + ((code >> 4) & 0xf);
    encoded[i * 2 + 1] = 'A'.charCodeAt(0) + (code & 0xf);
  }
  return encoded;
}

function decodeNbnsName(encoded) {
  if (encoded.length < 32) return null;
  let name = '';
  for (let i = 0; i < 16; i++) {
    const upper = encoded[i * 2] - 'A'.charCodeAt(0);
    const lower = encoded[i * 2 + 1] - 'A'.charCodeAt(0);
    if (upper < 0 || upper > 15 || lower < 0 || lower > 15) continue;
    const code = (upper << 4) | lower;
    if (code === 0 || code === 0x20) break;
    name += String.fromCharCode(code);
  }
  return name.trim() || null;
}

// RDP detection (porta 3389).
// So verifica se a porta esta aberta com banner basico.
async function probeRdp(host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    let data = '';

    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };

    sock.setTimeout(timeoutMs);

    sock.on('data', (chunk) => {
      data += chunk.toString('hex');
      // RDP Connection Confirm: 03 00 00
      if (data.length >= 8 && data.startsWith('030000')) {
        finish({
          protocol: 'rdp',
          open: true,
          os_hint: 'Windows',
          raw: data.slice(0, 256),
        });
      }
    });

    sock.on('connect', () => {
      // RDP Connection Request
      const pkt = Buffer.from('030000130ee000000000000100080000000000', 'hex');
      sock.write(pkt);
    });

    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));

    sock.connect(3389, host);
  });
}

// Scan Windows completo: SMB + NetBIOS + RDP.
async function scanWindowsHost(host, opts = {}) {
  const result = {
    host,
    smb: null,
    netbios: null,
    rdp: null,
    is_windows: false,
    os_version: null,
    hostname: null,
    domain: null,
  };

  // Paralelo para speed
  const [smb, nbns, rdp] = await Promise.all([
    probeSmb(host, opts.timeout || 2000),
    probeNetbios(host, opts.timeout || 1500),
    probeRdp(host, opts.timeout || 2000),
  ]);

  result.smb = smb;
  result.netbios = nbns;
  result.rdp = rdp;

  if (smb) {
    result.is_windows = true;
    result.os_version = smb.os_version || 'Windows (SMB)';
    result.hostname = smb.hostname || result.hostname;
    result.domain = smb.domain || result.domain;
  }

  if (nbns?.names?.length) {
    result.is_windows = true;
    const wkst = nbns.names.find(n => n.type === '<workstation>');
    if (wkst) result.hostname = wkst.name;
  }

  if (rdp?.open) {
    result.is_windows = true;
    if (!result.os_version) result.os_version = 'Windows (RDP)';
  }

  return result;
}

module.exports = { probeSmb, probeNetbios, probeRdp, scanWindowsHost };
