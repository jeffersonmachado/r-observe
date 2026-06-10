'use strict';

/**
 * Fixtures reais de descoberta de rede local.
 *
 * Dados coletados com:
 *   sudo arp-scan --localnet
 *   sudo nmap -sn 192.168.0.0/24
 *   sudo nmap -O 192.168.0.43
 */

// Gateway: 192.168.0.1 — MAC localmente administrado
const gatewayArpRaw = {
  primary_ip: '192.168.0.1',
  mac_address: '02:10:18:5c:5e:4b',
  vendor: 'Unknown',
  mac_type: 'locally_administered',
  is_locally_administered: true,
  vendor_reliable: false,
  device: 'eth0',
  discovery_method: 'arp_scan',
  confidence: 0.95,
  device_type: 'host',
  metadata: {
    mac_metadata: {
      mac_address: '02:10:18:5c:5e:4b',
      mac_type: 'locally_administered',
      is_locally_administered: true,
      is_multicast: false,
      vendor: 'Unknown',
      vendor_reliable: false,
      vendor_reliability_reason: 'MAC is locally administered — OUI does not follow IEEE assignment',
    },
  },
};

// Host 192.168.0.43 — MAC com vendor na OUI (Motorola/Hisense)
// NOTA: 50:BA:02 está na base OUI como Motorola/Hisense, então vendor_reliable = true
const appServerArpRaw = {
  primary_ip: '192.168.0.43',
  mac_address: '50:BA:02:B0:9C:4A',
  vendor: 'Motorola/Hisense',
  mac_type: 'global_unicast',
  is_locally_administered: false,
  vendor_reliable: true,
  device: 'eth0',
  discovery_method: 'arp_scan',
  confidence: 0.95,
  device_type: 'unknown_network_device',
  metadata: {
    mac_metadata: {
      mac_address: '50:ba:02:b0:9c:4a',
      mac_type: 'global_unicast',
      is_locally_administered: false,
      is_multicast: false,
      vendor: 'Motorola/Hisense',
      vendor_reliable: true,
      vendor_reliability_reason: 'MAC is global unicast with known OUI',
    },
  },
};

// Host com MAC verdadeiramente desconhecido (para teste de fallback)
const unknownMacHost = {
  primary_ip: '192.168.0.99',
  mac_address: 'de:ad:be:ef:00:01',
  vendor: null,
  mac_type: 'global_unicast',
  is_locally_administered: false,
  vendor_reliable: false,
  device: 'eth0',
  discovery_method: 'arp',
  confidence: 0.9,
  device_type: 'unknown_network_device',
  metadata: {
    mac_metadata: {
      mac_address: 'de:ad:be:ef:00:01',
      mac_type: 'global_unicast',
      is_locally_administered: false,
      is_multicast: false,
      vendor: null,
      vendor_reliable: false,
      vendor_reliability_reason: 'Vendor not found in OUI database',
    },
  },
};

// Resultado do nmap -O para 192.168.0.43
const appServerNmapScan = {
  address: '192.168.0.43',
  hostname: null,
  open_ports: [
    { port: 7000, protocol: 'tcp', service: 'afs3-fileserver', state: 'open' },
    { port: 8008, protocol: 'tcp', service: 'http', state: 'open' },
    { port: 8009, protocol: 'tcp', service: 'ajp13', state: 'open' },
    { port: 8088, protocol: 'tcp', service: 'radan-http', state: 'filtered' },
    { port: 8443, protocol: 'tcp', service: 'https-alt', state: 'open' },
    { port: 9000, protocol: 'tcp', service: 'cslistener', state: 'open' },
    { port: 9001, protocol: 'tcp', service: 'tor-orport', state: 'filtered' },
  ],
  distance: 1,
  os_hint: null,
  os_match: null,
};

// Máquina local: 192.168.0.50
const localHostArpRaw = {
  primary_ip: '192.168.0.50',
  mac_address: '66:5a:ab:72:63:01',
  vendor: 'Unknown',
  mac_type: 'locally_administered',
  is_locally_administered: true,
  vendor_reliable: false,
  device: 'eth0',
  discovery_method: 'arp_scan',
  confidence: 0.95,
  device_type: 'host',
  metadata: {
    mac_metadata: {
      mac_address: '66:5a:ab:72:63:01',
      mac_type: 'locally_administered',
      is_locally_administered: true,
      is_multicast: false,
      vendor: 'Unknown',
      vendor_reliable: false,
      vendor_reliability_reason: 'MAC is locally administered — OUI does not follow IEEE assignment',
    },
  },
};

// Resultado esperado para o gateway
const expectedGateway = {
  ip: '192.168.0.1',
  mac: '02:10:18:5c:5e:4b',
  vendor: 'Unknown',
  vendor_reliable: false,
  mac_type: 'locally_administered',
  hostname: null,
  is_gateway: true,
  is_localhost: false,
};

// Resultado esperado para o app server (192.168.0.43)
// NOTA: 50:BA:02 resolve para Motorola/Hisense na OUI — vendor é conhecido
const expectedAppServer = {
  ip: '192.168.0.43',
  mac: '50:ba:02:b0:9c:4a',
  vendor: 'Motorola/Hisense',
  vendor_reliable: true,
  mac_type: 'global_unicast',
  hostname: null,
  is_gateway: false,
  is_localhost: false,
  open_ports: [
    { port: 7000, protocol: 'tcp', service: 'afs3-fileserver', state: 'open' },
    { port: 8008, protocol: 'tcp', service: 'http', state: 'open' },
    { port: 8009, protocol: 'tcp', service: 'ajp13', state: 'open' },
    { port: 8443, protocol: 'tcp', service: 'https-alt', state: 'open' },
    { port: 9000, protocol: 'tcp', service: 'cslistener', state: 'open' },
  ],
  filtered_ports: [
    { port: 8088, protocol: 'tcp', service: 'radan-http', state: 'filtered' },
    { port: 9001, protocol: 'tcp', service: 'tor-orport', state: 'filtered' },
  ],
  asset_type: 'application_server',
  possible_stack: ['Java', 'Apache Tomcat', 'Application Server'],
  confidence: 80,
};

// Resultado esperado para localhost
const expectedLocalhost = {
  ip: '192.168.0.50',
  mac: '66:5a:ab:72:63:01',
  vendor: 'Unknown',
  vendor_reliable: false,
  mac_type: 'locally_administered',
  hostname: null,
  is_gateway: false,
  is_localhost: true,
};

module.exports = {
  gatewayArpRaw,
  appServerArpRaw,
  unknownMacHost,
  appServerNmapScan,
  localHostArpRaw,
  expectedGateway,
  expectedAppServer,
  expectedLocalhost,
};
