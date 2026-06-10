'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseSnmpOutput, buildSnmpCommands } = require('../../src/scanners/snmp-discovery');

test('parseSnmpOutput extrai campos basicos', () => {
  const sample = [
    'SNMPv2-MIB::sysDescr.0 = STRING: Linux host 6.1.0',
    'DISMAN-EVENT-MIB::sysUpTimeInstance = Timeticks: (12345) 0:02:03.45',
    'SNMPv2-MIB::sysName.0 = STRING: core-switch-01',
  ].join('\n');

  const out = parseSnmpOutput(sample);
  assert.ok(out.sysDescr && out.sysDescr.includes('Linux host'));
  assert.ok(out.sysName && out.sysName.includes('core-switch-01'));
  assert.ok(out.sysUptime);
});

test('parseSnmpOutput aceita OID numerico', () => {
  const sample = [
    '.1.3.6.1.2.1.1.1.0 = STRING: Cisco IOS XE',
    '.1.3.6.1.2.1.1.3.0 = Timeticks: (123) 0:00:01.23',
    '.1.3.6.1.2.1.1.5.0 = STRING: dist-sw-01',
  ].join('\n');

  const out = parseSnmpOutput(sample);
  assert.ok(out.sysDescr && out.sysDescr.includes('Cisco'));
  assert.ok(out.sysName && out.sysName.includes('dist-sw-01'));
});

test('parseSnmpOutput extrai interfaces, vlan e vizinhos', () => {
  const sample = [
    'SNMPv2-MIB::sysDescr.0 = STRING: Cisco IOS XE C9200',
    'IF-MIB::ifName.1 = STRING: Gi1/0/1',
    'IF-MIB::ifDescr.1 = STRING: GigabitEthernet1/0/1',
    'IF-MIB::ifOperStatus.1 = INTEGER: up(1)',
    'Q-BRIDGE-MIB::dot1qVlanStaticName.10 = STRING: USERS',
    'LLDP-MIB::lldpRemSysName.1.0.1 = STRING: core-router-01',
  ].join('\n');

  const out = parseSnmpOutput(sample);
  assert.strictEqual(out.vendor, 'Cisco');
  assert.strictEqual(out.interfaces.length, 1);
  assert.ok(out.interfaces[0].name.includes('Gi1/0/1'));
  assert.ok(out.vlans.includes('USERS'));
  assert.ok(out.neighbors.some((n) => n.includes('core-router-01')));
});

test('parseSnmpOutput detecta auth failure', () => {
  const sample = 'SNMPv2-MIB::sysDescr.0 = STRING: auth\nauthentication failure';
  const out = parseSnmpOutput(sample);
  assert.strictEqual(out.authFailure, true);
});

test('buildSnmpCommands gera comandos v2c', () => {
  const commands = buildSnmpCommands('10.10.2.1', { version: '2c', community: 'public' });
  assert.strictEqual(commands.length, 2);
  assert.ok(commands[0].includes('snmpbulkwalk'));
  assert.ok(commands[0].includes('-v 2c'));
  assert.ok(commands[0].includes("-c 'public'"));
});

test('buildSnmpCommands gera comandos v3 authPriv', () => {
  const commands = buildSnmpCommands('10.10.2.1', {
    version: '3',
    user: 'snmpuser',
    securityLevel: 'authPriv',
    authProtocol: 'SHA',
    authPassword: 'authpass',
    privProtocol: 'AES',
    privPassword: 'privpass',
  });
  assert.strictEqual(commands.length, 2);
  assert.ok(commands[0].includes('-v3'));
  assert.ok(commands[0].includes("-u 'snmpuser'"));
  assert.ok(commands[0].includes('-l authPriv'));
  assert.ok(commands[0].includes("-A 'authpass'"));
  assert.ok(commands[0].includes("-X 'privpass'"));
});

test('buildSnmpCommands gera comandos v1', () => {
  const commands = buildSnmpCommands('10.10.2.1', { version: '1', community: 'public' });
  assert.strictEqual(commands.length, 2);
  assert.ok(commands[0].includes('-v 1'));
});
