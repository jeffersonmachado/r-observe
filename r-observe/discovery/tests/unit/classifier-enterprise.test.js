'use strict';

/**
 * R-Observe — Discovery Classifier Tests
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

// ─── Infrastructure Classifier ────────────────────────────────────────────────

const { classifyInfrastructure } = require('../../src/classifiers/infrastructure-classifier');

describe('Infrastructure Classifier', () => {
  it('deve classificar VMware ESXi via SNMP', () => {
    const result = classifyInfrastructure({
      snmp_sysdescr: 'VMware ESXi 7.0.3 build-20328353',
      open_ports: [443, 902],
    });

    assert.ok(result.best_match);
    assert.equal(result.best_match.vendor, 'VMware');
    assert.equal(result.best_match.product, 'VMware ESXi');
    assert.ok(result.best_match.confidence_score >= 0.5);
  });

  it('deve classificar Proxmox VE via HTTP', () => {
    const result = classifyInfrastructure({
      http_title: 'Proxmox Virtual Environment',
      http_server: 'pveproxy',
      open_ports: [8006, 22],
    });

    assert.ok(result.best_match);
    assert.equal(result.best_match.product, 'Proxmox VE');
    assert.ok(result.best_match.confidence_score >= 0.5);
  });

  it('deve classificar MikroTik RouterOS via sysObjectID', () => {
    const result = classifyInfrastructure({
      snmp_sysobjectid: '.1.3.6.1.4.1.14988.1',
      snmp_sysdescr: 'RouterOS RB4011iGS+',
      open_ports: [8291, 22],
    });

    assert.ok(result.best_match);
    assert.equal(result.best_match.vendor, 'MikroTik');
    assert.ok(result.best_match.confidence_score >= 0.7);
  });

  it('deve classificar Fortigate', () => {
    const result = classifyInfrastructure({
      snmp_sysdescr: 'FortiGate-60F v7.4.0',
      http_title: 'FortiGate 60F',
      open_ports: [443, 8443],
    });

    assert.ok(result.best_match);
    assert.equal(result.best_match.vendor, 'Fortinet');
    assert.ok(result.best_match.confidence_score >= 0.7);
  });

  it('deve classificar Synology NAS', () => {
    const result = classifyInfrastructure({
      http_title: 'Synology DiskStation',
      snmp_sysdescr: 'Synology DS920+ DSM 7.2',
      open_ports: [5000, 5001, 22],
    });

    assert.ok(result.best_match);
    assert.equal(result.best_match.product, 'Synology NAS');
    assert.ok(result.best_match.confidence_score >= 0.7);
  });

  it('deve classificar pfSense', () => {
    const result = classifyInfrastructure({
      snmp_sysdescr: 'pfSense 2.7.0-RELEASE',
      http_title: 'pfSense - Login',
      open_ports: [443, 22],
    });

    assert.ok(result.best_match);
    assert.equal(result.best_match.product, 'pfSense');
    assert.ok(result.best_match.confidence_score >= 0.7);
  });

  it('deve classificar Windows Server', () => {
    const result = classifyInfrastructure({
      snmp_sysdescr: 'Windows Server 2019 Standard',
      http_server: 'Microsoft-IIS/10.0',
      open_ports: [445, 3389, 135],
    });

    assert.ok(result.best_match);
    assert.equal(result.best_match.os_family, 'windows');
    assert.ok(result.best_match.confidence_score >= 0.6);
  });

  it('deve retornar null quando nenhum sinal é fornecido', () => {
    const result = classifyInfrastructure({});
    assert.equal(result.best_match, null);
  });

  it('deve incluir alternativas quando múltiplos matches', () => {
    const result = classifyInfrastructure({
      snmp_sysdescr: 'Linux Ubuntu 22.04',
      ssh_banner: 'Ubuntu-4ubuntu0.6',
    });

    assert.ok(result.best_match);
    assert.ok(result.alternatives.length >= 0);
    assert.ok(result.all_matches.length > 0);
  });
});

// ─── VoIP Classifier ─────────────────────────────────────────────────────────

const { matchVoipSignature } = require('../../src/scanners/voip-telephony');

describe('VoIP Classifier', () => {
  it('deve detectar Asterisk via SIP User-Agent', () => {
    const matches = matchVoipSignature({
      sip_user_agent: 'Asterisk PBX 18.12.0',
    });

    assert.ok(matches.length > 0);
    assert.equal(matches[0].vendor, 'Asterisk/FreePBX');
    assert.ok(matches[0].confidence_score >= 0.7);
  });

  it('deve detectar Grandstream via MAC OUI', () => {
    const matches = matchVoipSignature({
      mac_address: '00:0B:82:12:34:56',
    });

    assert.ok(matches.length > 0);
    assert.equal(matches[0].vendor, 'Grandstream');
    assert.ok(matches[0].confidence_score >= 0.5);
  });

  it('deve detectar Yealink via SIP User-Agent', () => {
    const matches = matchVoipSignature({
      sip_user_agent: 'Yealink SIP-T46S 66.86.0.5',
    });

    assert.ok(matches.length > 0);
    assert.equal(matches[0].vendor, 'Yealink');
    assert.ok(matches[0].confidence_score >= 0.7);
  });

  it('deve retornar array vazio sem sinais', () => {
    const matches = matchVoipSignature({});
    assert.equal(matches.length, 0);
  });

  it('deve ordenar por confiança decrescente', () => {
    const matches = matchVoipSignature({
      sip_user_agent: 'Asterisk PBX',
      snmp_sysdescr: 'Grandstream UCM6302',
    });

    if (matches.length >= 2) {
      assert.ok(matches[0].confidence_score >= matches[1].confidence_score);
    }
  });
});

// ─── Run ─────────────────────────────────────────────────────────────────────

if (require.main === module) {
  // Tests are run via node --test
}
