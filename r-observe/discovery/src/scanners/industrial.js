'use strict';

// Industrial Protocols Scanner para R-Observe Discovery (Enterprise).
// Descobre dispositivos OT/ICS via:
// - Modbus TCP (porta 502) - CLPs, RTUs, sensores industriais
// - BACnet/IP (porta 47808/UDP) - Building automation, HVAC
// - Profinet (porta 34964/UDP) - Siemens, automação industrial
// - EtherNet/IP (portas 44818 TCP + 2222 UDP) - Rockwell/Allen-Bradley
// - OPC UA (porta 4840) - Industrial IoT
// - MQTT (porta 1883) - IoT messaging

const dgram = require('dgram');
const net = require('net');
const { log } = require('../utils/logger');

// ── Modbus TCP (porta 502) ───────────────────────────────────────────────

async function probeModbus(host, timeoutMs = 2000) {
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
      // Modbus TCP response: transaction ID(2) + protocol(2) + length(2) + unitID(1) + function(1)
      if (buffer.length >= 8) {
        const transactionId = buffer.readUInt16BE(0);
        const protocol = buffer.readUInt16BE(2);
        const funcCode = buffer[7];

        if (protocol === 0) {
          finish({
            protocol: 'modbus-tcp',
            transaction_id: transactionId,
            function_code: funcCode,
            function_name: modbusFunctionName(funcCode),
            open: true,
          });
        } else {
          finish(null);
        }
      }
    });

    sock.on('connect', () => {
      // Read Holding Registers request (function 0x03)
      const pkt = Buffer.from([
        0x00, 0x01,  // Transaction ID
        0x00, 0x00,  // Protocol (Modbus = 0)
        0x00, 0x06,  // Length
        0x01,        // Unit ID
        0x03,        // Function: Read Holding Registers
        0x00, 0x00,  // Starting address
        0x00, 0x01,  // Quantity
      ]);
      sock.write(pkt);
    });

    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));

    sock.connect(502, host);
  });
}

function modbusFunctionName(code) {
  const names = { 1: 'Read Coils', 2: 'Read Discrete Inputs', 3: 'Read Holding Registers',
    4: 'Read Input Registers', 5: 'Write Single Coil', 6: 'Write Single Register',
    15: 'Write Multiple Coils', 16: 'Write Multiple Registers' };
  return names[code] || `Function ${code}`;
}

// ── BACnet/IP (porta 47808/UDP) ─────────────────────────────────────────

function probeBacnet(host, timeoutMs = 2000) {
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
      if (msg.length < 4) return finish(null);

      // BACnet BVLC header: type(1) + function(1) + length(2)
      const bvlcType = msg[0];  // 0x81 = BACnet/IP
      const bvlcFunc = msg[1];  // 0x0A = Original-Unicast-NPDU, 0x0B = Original-Broadcast-NPDU

      if (bvlcType === 0x81 && (bvlcFunc === 0x0A || bvlcFunc === 0x0B)) {
        // NPDU header: version(1) + control(1)
        if (msg.length >= 6) {
          const npduVersion = msg[4];
          const npduControl = msg[5];

          // Tenta extrair dados APDU (apos NPDU header)
          let deviceId = null;
          let vendorId = null;
          if (msg.length > 6) {
            const apdu = msg.slice(6);
            if (apdu.length >= 4) {
              const apduType = apdu[0] >> 4;
              if (apduType === 0x0) { // Confirmed-Request
                // Tenta ler dados a partir do service choice
              }
              if (apduType === 0x2 || apduType === 0x3) { // Complex-ACK ou Simple-ACK
                // Who-Is / I-Am response
                if (apdu.length >= 10) {
                  deviceId = apdu.readUInt32BE(2);
                }
              }
            }
          }

          finish({
            protocol: 'bacnet-ip',
            bvlc_function: bacnetBvlcName(bvlcFunc),
            npdu_version: npduVersion,
            device_id: deviceId,
            open: true,
          });
          return;
        }
      }

      finish({ protocol: 'bacnet-ip', open: true, raw: msg.slice(0, 64).toString('hex') });
    });

    sock.on('error', () => finish(null));

    // Who-Is request: descobre todos os dispositivos BACnet na rede
    const whois = buildBacnetWhoIs();
    sock.send(whois, 47808, host, (err) => {
      if (err) finish(null);
    });
  });
}

function bacnetBvlcName(code) {
  const names = {
    0x00: 'Result',
    0x01: 'Write-Broadcast-Distribution-Table',
    0x02: 'Read-Broadcast-Distribution-Table',
    0x03: 'Forwarded-NPDU',
    0x04: 'Register-Foreign-Device',
    0x05: 'Read-Foreign-Device-Table',
    0x06: 'Delete-Foreign-Device-Table-Entry',
    0x07: 'Distribute-Broadcast-To-Network',
    0x0A: 'Original-Unicast-NPDU',
    0x0B: 'Original-Broadcast-NPDU',
  };
  return names[code] || `BVLC-${code}`;
}

function buildBacnetWhoIs() {
  // BVLC: type=0x81, function=0x0B (broadcast), length=4+2+2+2
  // NPDU: version=1, control=0x00
  // APDU: Who-Is (unconfirmed request, service=8)
  return Buffer.from([
    0x81,        // BVLC type: BACnet/IP
    0x0B,        // BVLC function: Original-Broadcast-NPDU
    0x00, 0x0C,  // BVLC length: 12 bytes
    0x01,        // NPDU version
    0x00,        // NPDU control
    0x10,        // APDU: PDU type=1 (unconfirmed), 0 segments
    0x08,        // Service choice: Who-Is (8)
    0x00, 0x00,  // Low limit (unrestricted)
    0x00, 0x00,  // High limit (unrestricted)
  ]);
}

// ── Profinet (porta 34964/UDP) ──────────────────────────────────────────

function probeProfinet(host, timeoutMs = 2000) {
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
      // Profinet DCP Identify Request response
      // FrameID: 0xFEFE para DCP Identify
      if (msg.length >= 4) {
        const frameId = msg.readUInt16BE(0);
        if (frameId === 0xFEFE || frameId === 0xFEFF) {
          finish({
            protocol: 'profinet-dcp',
            frame_id: `0x${frameId.toString(16)}`,
            open: true,
            raw_len: msg.length,
          });
          return;
        }
      }
      finish({ protocol: 'profinet', open: true, raw_len: msg.length });
    });

    sock.on('error', () => finish(null));

    // Profinet DCP Identify Request (multicast)
    const pkt = buildProfinetIdentify();
    sock.send(pkt, 34964, host, (err) => {
      if (err) finish(null);
    });
  });
}

function buildProfinetIdentify() {
  // DCP Identify Request: FrameID=0xFEFE, ServiceID=5 (Identify)
  return Buffer.from([
    0xFE, 0xFE,       // FrameID: DCP Identify
    0x05,              // ServiceID: Identify
    0x00,              // ServiceType: Request
    0x00, 0x00,        // Xid
    0x00, 0x00,        // ResponseDelay
    0x00, 0x00,        // Reserved
    0x00, 0x00,        // Option (none)
    0x00, 0x00,        // Suboption (none)
    0xFF, 0xFF, 0xFF, 0xFF,  // NameOfStation (wildcard)
  ]);
}

// ── EtherNet/IP (portas 44818 TCP + 2222 UDP) ──────────────────────────

async function probeEthernetIp(host, timeoutMs = 2000) {
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
      // EtherNet/IP encapsulation header: command(2) + length(2) + session(4) + status(4)
      if (buffer.length >= 24) {
        const command = buffer.readUInt16LE(0);
        const length = buffer.readUInt16LE(2);
        const status = buffer.readUInt32LE(8);

        if (command === 0x0065 && status === 0) { // Register Session response
          finish({
            protocol: 'ethernet-ip',
            session_established: true,
            open: true,
          });
        } else {
          finish({ protocol: 'ethernet-ip', open: true, command: `0x${command.toString(16)}` });
        }
      }
    });

    sock.on('connect', () => {
      // Register Session request
      const pkt = Buffer.alloc(28, 0);
      pkt.writeUInt16LE(0x0065, 0);   // Command: Register Session
      pkt.writeUInt16LE(4, 2);         // Length
      pkt.writeUInt32LE(0, 4);         // Session handle
      pkt.writeUInt32LE(0, 8);         // Status
      pkt.writeUInt32LE(0, 24);        // Options
      pkt.writeUInt16LE(1, 24);        // Protocol version
      pkt.writeUInt16LE(0, 26);        // Option flags
      sock.write(pkt);
    });

    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));

    sock.connect(44818, host);
  });
}

// ── OPC UA (porta 4840) ─────────────────────────────────────────────────

async function probeOpcUa(host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };

    sock.setTimeout(timeoutMs);

    sock.on('data', (data) => {
      // OPC UA TCP Hello message: MessageType(3) + ChunkType(1) + MessageSize(4)
      if (data.length >= 8) {
        const msgType = data.toString('ascii', 0, 3);
        if (msgType === 'HEL' || msgType === 'ACK' || msgType === 'ERR') {
          finish({
            protocol: 'opc-ua',
            message_type: msgType,
            open: true,
          });
          return;
        }
      }
      // Se recebeu dados mas nao identificou, marca como aberto
      finish({ protocol: 'opc-ua', open: true, raw_prefix: data.slice(0, 32).toString('hex') });
    });

    sock.on('connect', () => {
      // OPC UA Hello message
      const hello = Buffer.alloc(32, 0);
      hello.write('HEL', 0);      // MessageType: HEL
      hello.write('F', 3);        // ChunkType: F (final)
      hello.writeUInt32LE(32, 4); // MessageSize
      hello.writeUInt32LE(0, 8);  // ProtocolVersion
      hello.writeUInt32LE(8192, 12); // ReceiveBufferSize
      hello.writeUInt32LE(8192, 16); // SendBufferSize
      hello.writeUInt32LE(65536, 20); // MaxMessageSize
      hello.writeUInt32LE(100, 24);    // MaxChunkCount
      sock.write(hello);
    });

    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));

    sock.connect(4840, host);
  });
}

// ── MQTT (porta 1883) ───────────────────────────────────────────────────

function probeMqtt(host, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };

    sock.setTimeout(timeoutMs);

    sock.on('data', (data) => {
      // MQTT CONNACK: packet type = 0x20 (CONNACK)
      if (data.length >= 2) {
        const pktType = data[0] >> 4;
        if (pktType === 2) { // CONNACK
          const returnCode = data[3] || 0;
          const codes = { 0: 'Accepted', 1: 'Unacceptable protocol', 2: 'Identifier rejected',
            3: 'Server unavailable', 4: 'Bad credentials', 5: 'Not authorized' };
          finish({
            protocol: 'mqtt',
            connack: codes[returnCode] || `Code ${returnCode}`,
            open: true,
          });
          return;
        }
      }
      finish({ protocol: 'mqtt', open: true });
    });

    sock.on('connect', () => {
      // MQTT CONNECT packet
      const connect = Buffer.from([
        0x10, 0x10,  // Fixed header: CONNECT, remaining length=16
        0x00, 0x04, 'M', 'Q', 'T', 'T',  // Protocol name
        0x04,        // Protocol level (3.1.1)
        0x02,        // Connect flags (clean session)
        0x00, 0x3C,  // Keep alive (60s)
        0x00, 0x06, 'r', '-', 'o', 'b', 's', 'e',  // Client ID
      ]);
      sock.write(connect);
    });

    sock.on('timeout', () => finish(null));
    sock.on('error', () => finish(null));

    sock.connect(1883, host);
  });
}

// ── Orquestrador ─────────────────────────────────────────────────────────

async function scanIndustrialHost(host, opts = {}) {
  const timeout = opts.timeout || 2000;
  const results = [];

  const probes = [
    { name: 'modbus', probe: () => probeModbus(host, timeout) },
    { name: 'bacnet', probe: () => probeBacnet(host, timeout) },
    { name: 'profinet', probe: () => probeProfinet(host, timeout) },
    { name: 'ethernet-ip', probe: () => probeEthernetIp(host, timeout) },
    { name: 'opc-ua', probe: () => probeOpcUa(host, timeout) },
    { name: 'mqtt', probe: () => probeMqtt(host, timeout) },
  ];

  const probeResults = await Promise.all(probes.map(async (p) => {
    try {
      const r = await p.probe();
      return r ? { ...r, probe: p.name, host } : null;
    } catch { return null; }
  }));

  for (const r of probeResults) {
    if (r) results.push(r);
  }

  return results;
}

module.exports = {
  probeModbus,
  probeBacnet,
  probeProfinet,
  probeEthernetIp,
  probeOpcUa,
  probeMqtt,
  scanIndustrialHost,
};
