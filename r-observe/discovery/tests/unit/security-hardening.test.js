'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isValidHost, isValidPort } = require('../../src/validators');
const { nmapServiceScan } = require('../../src/scanners/nmap-sv');
const { pingHost } = require('../../src/scanners/ping-sweep');
const { ping6Host } = require('../../src/scanners/ipv6');
const { snmpWalk, snmpGet, isValidOid } = require('../../src/mibs/snmp-walk');
const { buildSnmpInvocations } = require('../../src/scanners/snmp-discovery');
const { isValidSubnet } = require('../../src/scanners/arp-discovery');

test('host validator accepts network identifiers and rejects shell syntax', () => {
  assert.equal(isValidHost('10.10.2.30'), true);
  assert.equal(isValidHost('router-01.example.local'), true);
  assert.equal(isValidHost('2001:db8::1'), true);
  assert.equal(isValidHost('10.0.0.1;touch /tmp/pwned'), false);
  assert.equal(isValidHost('$(id)'), false);
});

test('port validator accepts only the TCP/UDP port range', () => {
  assert.equal(isValidPort(22), true);
  assert.equal(isValidPort('65535'), true);
  assert.equal(isValidPort(0), false);
  assert.equal(isValidPort('22;id'), false);
});

test('nmap rejects an unsafe host before launching a process', async () => {
  assert.deepEqual(await nmapServiceScan('127.0.0.1;touch /tmp/pwned', [80]), []);
});

test('network probes reject shell syntax before launching a process', async () => {
  assert.deepEqual(await pingHost('127.0.0.1;touch /tmp/pwned'), {
    alive: false,
    host: '127.0.0.1;touch /tmp/pwned',
  });
  assert.deepEqual(await ping6Host('::1;touch /tmp/pwned'), {
    alive: false,
    host: '::1;touch /tmp/pwned',
    family: 6,
  });
  assert.deepEqual(await snmpWalk('127.0.0.1;id', '1.3.6.1.2.1'), []);
  assert.equal(await snmpGet('127.0.0.1;id', '1.3.6.1.2.1'), null);
});

test('SNMP OID validation rejects options and shell syntax', () => {
  assert.equal(isValidOid('1.3.6.1.2.1.1'), true);
  assert.equal(isValidOid('IF-MIB::ifDescr.1'), true);
  assert.equal(isValidOid('--help'), false);
  assert.equal(isValidOid('1.3.6.1;id'), false);
});

test('legacy SNMP and ARP execution plans reject unsafe input', () => {
  assert.deepEqual(buildSnmpInvocations('127.0.0.1;id', {}, '1.3.6.1.2.1'), []);
  assert.deepEqual(buildSnmpInvocations('127.0.0.1', {}, '--help'), []);
  assert.equal(isValidSubnet('10.10.2.0/24'), true);
  assert.equal(isValidSubnet('10.10.2.0/24;id'), false);
  assert.equal(isValidSubnet('--help'), false);
});
