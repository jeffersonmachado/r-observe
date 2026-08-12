'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizePassiveEvent } = require('../../src/passive/parser');
const { parseSyslogMessage, parseSsdpMessage, parseMdnsMessage, parseSnmpTrapMessage } = require('../../src/passive/receivers');
const { createPassiveIngest } = require('../../src/passive/ingest');

test('normalizePassiveEvent identifica IP, host e MAC', () => {
  const evt = normalizePassiveEvent({
    source: 'syslog',
    payload: { message: 'DHCP lease host cam-01.local ip 10.10.2.60 mac aa:bb:cc:dd:ee:ff' },
  });

  assert.ok(evt);
  assert.strictEqual(evt.type, 'syslog');
  assert.strictEqual(evt.source_ip, '10.10.2.60');
  assert.strictEqual(evt.hostname, 'cam-01.local');
  assert.strictEqual(evt.mac, 'aa:bb:cc:dd:ee:ff');
});

test('parseSyslogMessage classifica tipo dhcp', () => {
  const evt = parseSyslogMessage('DHCPACK on 10.10.2.100 to aa:bb:cc:dd:ee:ff');
  assert.strictEqual(evt.type, 'dhcp');
  assert.ok(Array.isArray(evt.assets));
  assert.ok(Array.isArray(evt.fingerprints));
});

test('parseSsdpMessage extrai headers', () => {
  const msg = [
    'NOTIFY * HTTP/1.1',
    'HOST: 239.255.255.250:1900',
    'ST: upnp:rootdevice',
    'USN: uuid:abc',
    'SERVER: Test/1.0 UPnP/1.1',
  ].join('\n');

  const evt = parseSsdpMessage(msg);
  assert.strictEqual(evt.type, 'ssdp');
  assert.strictEqual(evt.payload.st, 'upnp:rootdevice');
  assert.strictEqual(evt.payload.usn, 'uuid:abc');
  assert.strictEqual(evt.history.event_type, 'ssdp');
});

test('parseMdnsMessage identifica hostname local', () => {
  const buf = Buffer.from('printer.local');
  const evt = parseMdnsMessage(buf);
  assert.strictEqual(evt.type, 'mdns');
  assert.strictEqual(evt.hostname, 'printer.local');
});

test('parseSnmpTrapMessage gera evento estruturado', () => {
  const evt = parseSnmpTrapMessage(Buffer.from('SNMP trap from 10.10.2.30'));
  assert.strictEqual(evt.type, 'snmp_trap');
  assert.ok(evt.payload.raw_hex);
  assert.ok(Array.isArray(evt.assets));
});

test('normalizePassiveEvent infere tipo a partir da source quando type ausente', () => {
  const evt = normalizePassiveEvent({
    source: 'snmp-trap-listener',
    payload: { raw: 'trap from 10.10.2.30' },
  });
  assert.ok(evt);
  assert.strictEqual(evt.type, 'snmp_trap');
  assert.strictEqual(evt.source_ip, '10.10.2.30');
});

test('normalizePassiveEvent normaliza payload string', () => {
  const evt = normalizePassiveEvent({
    source: 'syslog',
    payload: 'dhcp lease from 10.10.2.20',
  });
  assert.ok(evt);
  assert.strictEqual(evt.type, 'syslog');
  assert.strictEqual(evt.payload.message, 'dhcp lease from 10.10.2.20');
  assert.strictEqual(evt.source_ip, '10.10.2.20');
});

test('ingest passivo faz rollback e libera conexão quando a persistência falha', async () => {
  const calls = [];
  let released = false;
  const conn = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM observe_assets')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('INSERT INTO observe_discovery_findings')) throw new Error('db failure');
      return { rows: [], rowCount: 0 };
    },
    release() { released = true; },
  };
  const { ingestPassiveEvents } = createPassiveIngest({
    db: { connect: async () => conn },
    redis: null,
    log: () => {},
    parseScope: () => ({ tenant_id: 'tenant-a', site_id: 'site-a', edge_id: 'edge-a' }),
  });

  await assert.rejects(
    ingestPassiveEvents({ type: 'dhcp', source_ip: '10.0.0.10', payload: {} }),
    /db failure/
  );
  assert.strictEqual(calls[0], 'BEGIN');
  assert.match(calls[1], /pg_advisory_xact_lock/);
  assert.ok(calls.includes('ROLLBACK'));
  assert.strictEqual(released, true);
});
