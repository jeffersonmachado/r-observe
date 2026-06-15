'use strict';

/**
 * MIB OID Database — OIDs essenciais para SNMP profundo.
 * Cobre: system, interfaces, VLANs, sensores de hardware, wireless,
 *        protocolos de roteamento, ARP, entity MIB.
 *
 * Organizado por grupo funcional para facilitar manutenção.
 */

const OIDS = {
  // ── System (RFC 1213) ──────────────────────────────────────────────────
  system: {
    sysDescr:     '.1.3.6.1.2.1.1.1.0',
    sysObjectID:  '.1.3.6.1.2.1.1.2.0',
    sysUpTime:    '.1.3.6.1.2.1.1.3.0',
    sysContact:   '.1.3.6.1.2.1.1.4.0',
    sysName:      '.1.3.6.1.2.1.1.5.0',
    sysLocation:  '.1.3.6.1.2.1.1.6.0',
    sysServices:  '.1.3.6.1.2.1.1.7.0',
  },

  // ── Interfaces (RFC 2863) ─────────────────────────────────────────────
  interfaces: {
    ifNumber:           '.1.3.6.1.2.1.2.1.0',
    ifTable:            '.1.3.6.1.2.1.2.2',
    ifIndex:            '.1.3.6.1.2.1.2.2.1.1',
    ifDescr:            '.1.3.6.1.2.1.2.2.1.2',
    ifType:             '.1.3.6.1.2.1.2.2.1.3',
    ifMtu:              '.1.3.6.1.2.1.2.2.1.4',
    ifSpeed:            '.1.3.6.1.2.1.2.2.1.5',
    ifPhysAddress:      '.1.3.6.1.2.1.2.2.1.6',
    ifAdminStatus:      '.1.3.6.1.2.1.2.2.1.7',
    ifOperStatus:       '.1.3.6.1.2.1.2.2.1.8',
    ifLastChange:       '.1.3.6.1.2.1.2.2.1.9',
    ifInOctets:         '.1.3.6.1.2.1.2.2.1.10',
    ifInUcastPkts:      '.1.3.6.1.2.1.2.2.1.11',
    ifInDiscards:       '.1.3.6.1.2.1.2.2.1.13',
    ifInErrors:         '.1.3.6.1.2.1.2.2.1.14',
    ifOutOctets:        '.1.3.6.1.2.1.2.2.1.16',
    ifOutUcastPkts:     '.1.3.6.1.2.1.2.2.1.17',
    ifOutDiscards:      '.1.3.6.1.2.1.2.2.1.19',
    ifOutErrors:        '.1.3.6.1.2.1.2.2.1.20',
  },

  // ── ifXTable (64-bit counters, RFC 2863) ──────────────────────────────
  ifXTable: {
    ifName:             '.1.3.6.1.2.1.31.1.1.1.1',
    ifInMulticastPkts:  '.1.3.6.1.2.1.31.1.1.1.2',
    ifInBroadcastPkts:  '.1.3.6.1.2.1.31.1.1.1.3',
    ifOutMulticastPkts: '.1.3.6.1.2.1.31.1.1.1.4',
    ifOutBroadcastPkts: '.1.3.6.1.2.1.31.1.1.1.5',
    ifHCInOctets:       '.1.3.6.1.2.1.31.1.1.1.6',
    ifHCInUcastPkts:    '.1.3.6.1.2.1.31.1.1.1.7',
    ifHCOutOctets:      '.1.3.6.1.2.1.31.1.1.1.10',
    ifHCOutUcastPkts:   '.1.3.6.1.2.1.31.1.1.1.11',
    ifHighSpeed:        '.1.3.6.1.2.1.31.1.1.1.15',
    ifAlias:            '.1.3.6.1.2.1.31.1.1.1.18',
  },

  // ── IP / ARP (RFC 4293) ────────────────────────────────────────────────
  ip: {
    ipForwarding:        '.1.3.6.1.2.1.4.1.0',
    ipAdEntAddr:         '.1.3.6.1.2.1.4.20.1.1',
    ipAdEntIfIndex:      '.1.3.6.1.2.1.4.20.1.2',
    ipAdEntNetMask:      '.1.3.6.1.2.1.4.20.1.3',
    ipNetToMediaPhysAddress: '.1.3.6.1.2.1.4.22.1.2', // ARP table
    ipNetToMediaNetAddress:  '.1.3.6.1.2.1.4.22.1.3',
    ipNetToMediaType:    '.1.3.6.1.2.1.4.22.1.4',
    ipNetToMediaIfIndex: '.1.3.6.1.2.1.4.22.1.1',
  },

  // ── VLAN (Q-BRIDGE-MIB RFC 4363) ──────────────────────────────────────
  vlan: {
    dot1qVlanVersionNumber:   '.1.3.6.1.2.1.17.7.1.1.1',
    dot1qMaxVlanId:           '.1.3.6.1.2.1.17.7.1.1.2',
    dot1qVlanStaticName:      '.1.3.6.1.2.1.17.7.1.4.3.1.1',
    dot1qVlanStaticEgressPorts: '.1.3.6.1.2.1.17.7.1.4.3.1.2',
    dot1qVlanCurrentEgressPorts: '.1.3.6.1.2.1.17.7.1.4.2.1.4',
    dot1qVlanStaticUntaggedPorts: '.1.3.6.1.2.1.17.7.1.4.3.1.4',
    dot1qPvid:                '.1.3.6.1.2.1.17.7.1.4.5.1.1', // Port VLAN ID
  },

  // ── Entity MIB / Hardware Sensors (RFC 4133) ──────────────────────────
  entity: {
    entPhysicalDescr:       '.1.3.6.1.2.1.47.1.1.1.1.2',
    entPhysicalVendorType:  '.1.3.6.1.2.1.47.1.1.1.1.3',
    entPhysicalClass:       '.1.3.6.1.2.1.47.1.1.1.1.5',
    entPhysicalName:        '.1.3.6.1.2.1.47.1.1.1.1.7',
    entPhysicalHardwareRev: '.1.3.6.1.2.1.47.1.1.1.1.8',
    entPhysicalFirmwareRev: '.1.3.6.1.2.1.47.1.1.1.1.9',
    entPhysicalSoftwareRev: '.1.3.6.1.2.1.47.1.1.1.1.10',
    entPhysicalSerialNum:   '.1.3.6.1.2.1.47.1.1.1.1.11',
    entPhysicalModelName:   '.1.3.6.1.2.1.47.1.1.1.1.13',
    entPhysicalAlias:       '.1.3.6.1.2.1.47.1.1.1.1.14',
  },

  // ── Host Resources (RFC 2790) ─────────────────────────────────────────
  host: {
    hrSystemUptime:       '.1.3.6.1.2.1.25.1.1.0',
    hrSystemDate:         '.1.3.6.1.2.1.25.1.2.0',
    hrSystemNumUsers:     '.1.3.6.1.2.1.25.1.5.0',
    hrSystemProcesses:    '.1.3.6.1.2.1.25.1.6.0',
    hrSystemMaxProcesses: '.1.3.6.1.2.1.25.1.7.0',
    hrMemorySize:         '.1.3.6.1.2.1.25.2.2.0',
    hrStorageTable:       '.1.3.6.1.2.1.25.2.3',
    hrStorageType:        '.1.3.6.1.2.1.25.2.3.1.2',
    hrStorageDescr:       '.1.3.6.1.2.1.25.2.3.1.3',
    hrStorageAllocationUnits: '.1.3.6.1.2.1.25.2.3.1.4',
    hrStorageSize:        '.1.3.6.1.2.1.25.2.3.1.5',
    hrStorageUsed:        '.1.3.6.1.2.1.25.2.3.1.6',
    hrDeviceTable:        '.1.3.6.1.2.1.25.3.2',
    hrProcessorTable:     '.1.3.6.1.2.1.25.3.3',
    hrProcessorLoad:      '.1.3.6.1.2.1.25.3.3.1.2',
  },

  // ── CPU / Memory (UCD-SNMP-MIB / Net-SNMP) ───────────────────────────
  ucd: {
    ssCpuSystem:         '.1.3.6.1.4.1.2021.11.10.0',
    ssCpuUser:           '.1.3.6.1.4.1.2021.11.9.0',
    ssCpuIdle:           '.1.3.6.1.4.1.2021.11.11.0',
    ssCpuRawSystem:      '.1.3.6.1.4.1.2021.11.52.0',
    ssCpuRawUser:        '.1.3.6.1.4.1.2021.11.50.0',
    ssCpuRawIdle:        '.1.3.6.1.4.1.2021.11.53.0',
    ssCpuRawWait:        '.1.3.6.1.4.1.2021.11.54.0',
    memTotalReal:        '.1.3.6.1.4.1.2021.4.5.0',
    memAvailReal:        '.1.3.6.1.4.1.2021.4.6.0',
    memTotalSwap:        '.1.3.6.1.4.1.2021.4.3.0',
    memAvailSwap:        '.1.3.6.1.4.1.2021.4.4.0',
    memBuffer:           '.1.3.6.1.4.1.2021.4.14.0',
    memCached:           '.1.3.6.1.4.1.2021.4.15.0',
    laLoad:              '.1.3.6.1.4.1.2021.10.1',
    laLoadInt:           '.1.3.6.1.4.1.2021.10.1.1',
    laLoadFloat:         '.1.3.6.1.4.1.2021.10.1.3',
  },

  // ── OSPF (RFC 4750) ───────────────────────────────────────────────────
  ospf: {
    ospfRouterId:               '.1.3.6.1.2.1.14.1.1.0',
    ospfAdminStat:              '.1.3.6.1.2.1.14.1.2.0',
    ospfVersionNumber:          '.1.3.6.1.2.1.14.1.3.0',
    ospfAreaId:                 '.1.3.6.1.2.1.14.2.1.1',
    ospfNbrIpAddr:              '.1.3.6.1.2.1.14.10.1.1',
    ospfNbrRtrId:               '.1.3.6.1.2.1.14.10.1.3',
    ospfNbrState:               '.1.3.6.1.2.1.14.10.1.6',
    ospfIfIpAddress:            '.1.3.6.1.2.1.14.7.1.1',
    ospfIfType:                 '.1.3.6.1.2.1.14.7.1.3',
    ospfIfState:                '.1.3.6.1.2.1.14.7.1.12',
  },

  // ── BGP (RFC 4273) ────────────────────────────────────────────────────
  bgp: {
    bgpVersion:                 '.1.3.6.1.2.1.15.1.0',
    bgpLocalAs:                 '.1.3.6.1.2.1.15.2.0',
    bgpPeerRemoteAs:            '.1.3.6.1.2.1.15.3.1.9',
    bgpPeerState:               '.1.3.6.1.2.1.15.3.1.2',
    bgpPeerRemoteAddr:          '.1.3.6.1.2.1.15.3.1.7',
    bgpPeerFsmEstablishedTime:  '.1.3.6.1.2.1.15.3.1.16',
  },

  // ── VRRP (RFC 2787) ───────────────────────────────────────────────────
  vrrp: {
    vrrpOperVirtIpAddr:     '.1.3.6.1.2.1.68.1.3.1.1',
    vrrpOperState:          '.1.3.6.1.2.1.68.1.3.1.3',
    vrrpOperVirtualMacAddr: '.1.3.6.1.2.1.68.1.3.1.7',
    vrrpOperPriority:       '.1.3.6.1.2.1.68.1.3.1.2',
  },

  // ── Wireless / WiFi (IEEE 802.11 MIB) ─────────────────────────────────
  wireless: {
    dot11ManufacturerName:    '.1.2.840.10036.1.1.1.1',
    dot11StationID:           '.1.2.840.10036.1.1.1.3',
    dot11MACAddress:          '.1.2.840.10036.1.1.1.5',
    dot11DesiredSSID:         '.1.2.840.10036.2.1.1.4',
    dot11CurrentChannel:      '.1.2.840.10036.2.2.1.2',
    dot11CurrentTxPowerLevel: '.1.2.840.10036.2.2.1.4',
    dot11AssociatedStationCount: '.1.2.840.10036.1.2.1.1',
    // Unifi / Ubiquiti extensions
    unifiApModel:             '.1.3.6.1.4.1.41112.1.6.1.2.1.1.2',
    unifiApSystemModel:       '.1.3.6.1.4.1.41112.1.6.3.2.1.2',
    unifiRadioChannel:        '.1.3.6.1.4.1.41112.1.6.3.2.1.4',
    unifiRadioTxPower:        '.1.3.6.1.4.1.41112.1.6.3.2.1.6',
    unifiStaCount:            '.1.3.6.1.4.1.41112.1.6.1.2.1.1.5',
    // MikroTik wireless
    mtWirelessRegDomain:      '.1.3.6.1.4.1.14988.1.1.1.1.1.3',
    mtWirelessSSID:           '.1.3.6.1.4.1.14988.1.1.1.1.1.7',
    mtWirelessChannel:        '.1.3.6.1.4.1.14988.1.1.1.1.1.8',
    mtWirelessClientCount:    '.1.3.6.1.4.1.14988.1.1.1.1.1.9',
  },

  // ── SysObjectID → Vendor/Device mapping ────────────────────────────────
  sysObjectIDMap: {
    // Cisco
    '.1.3.6.1.4.1.9.1':      { vendor: 'Cisco',     category: 'network_device', technology: 'switch' },
    // MikroTik
    '.1.3.6.1.4.1.14988.1':  { vendor: 'MikroTik',  category: 'network_device', technology: 'router' },
    // Ubiquiti
    '.1.3.6.1.4.1.41112':    { vendor: 'Ubiquiti',  category: 'network_device', technology: 'wireless' },
    // HP / Aruba
    '.1.3.6.1.4.1.11':       { vendor: 'HP/Aruba',  category: 'network_device', technology: 'switch' },
    // Fortinet
    '.1.3.6.1.4.1.12356':    { vendor: 'Fortinet',  category: 'network_device', technology: 'firewall' },
    // Juniper
    '.1.3.6.1.4.1.2636':     { vendor: 'Juniper',   category: 'network_device', technology: 'router' },
    // Intelbras
    '.1.3.6.1.4.1.39106':    { vendor: 'Intelbras', category: 'network_device', technology: 'switch' },
    // Grandstream
    '.1.3.6.1.4.1.42397':    { vendor: 'Grandstream', category: 'voice', technology: 'voip' },
    // Hikvision
    '.1.3.6.1.4.1.39165':    { vendor: 'Hikvision', category: 'security', technology: 'camera' },
    // Dahua
    '.1.3.6.1.4.1.100483':   { vendor: 'Dahua',     category: 'security', technology: 'camera' },
    // ControlID
    '.1.3.6.1.4.1.48094':    { vendor: 'ControlID', category: 'security', technology: 'access_control' },
    // Net-SNMP (generic Linux/Unix)
    '.1.3.6.1.4.1.8072':     { vendor: 'Net-SNMP',  category: 'host', technology: 'server' },
    // VMware
    '.1.3.6.1.4.1.6876':     { vendor: 'VMware',    category: 'virtualization', technology: 'hypervisor' },
    // Synology
    '.1.3.6.1.4.1.6574':     { vendor: 'Synology',  category: 'storage', technology: 'nas' },
    // QNAP
    '.1.3.6.1.4.1.24681':    { vendor: 'QNAP',      category: 'storage', technology: 'nas' },
    // APC UPS
    '.1.3.6.1.4.1.318':      { vendor: 'APC',       category: 'power', technology: 'ups' },
    // Eaton UPS
    '.1.3.6.1.4.1.534':      { vendor: 'Eaton',     category: 'power', technology: 'ups' },
    // Dell
    '.1.3.6.1.4.1.674':      { vendor: 'Dell',      category: 'host', technology: 'server' },
    // HPE ProLiant
    '.1.3.6.1.4.1.232':      { vendor: 'HPE',       category: 'host', technology: 'server' },
    // Palo Alto
    '.1.3.6.1.4.1.25461':    { vendor: 'Palo Alto', category: 'network_device', technology: 'firewall' },
    // Check Point
    '.1.3.6.1.4.1.2620':     { vendor: 'Check Point', category: 'network_device', technology: 'firewall' },
    // F5
    '.1.3.6.1.4.1.3375':     { vendor: 'F5',        category: 'network_device', technology: 'load_balancer' },
    // Citrix
    '.1.3.6.1.4.1.3845':     { vendor: 'Citrix',    category: 'network_device', technology: 'load_balancer' },
    // Arista
    '.1.3.6.1.4.1.30065':    { vendor: 'Arista',    category: 'network_device', technology: 'switch' },
    // Brocade
    '.1.3.6.1.4.1.1588':     { vendor: 'Brocade',   category: 'network_device', technology: 'switch' },
    // Extreme Networks
    '.1.3.6.1.4.1.1916':     { vendor: 'Extreme',   category: 'network_device', technology: 'switch' },
    // Huawei
    '.1.3.6.1.4.1.2011':     { vendor: 'Huawei',    category: 'network_device', technology: 'router' },
    // ZTE
    '.1.3.6.1.4.1.3902':     { vendor: 'ZTE',       category: 'network_device', technology: 'router' },
    // Yealink
    '.1.3.6.1.4.1.32116':    { vendor: 'Yealink',   category: 'voice', technology: 'voip' },
    // pfSense
    '.1.3.6.1.4.1.12325':    { vendor: 'pfSense',   category: 'network_device', technology: 'firewall' },
  },
};

/**
 * Resolve sysObjectID para vendor/category/technology.
 * Testa prefixos (ex: .1.3.6.1.4.1.9.1.xxx → Cisco)
 */
function resolveSysObjectID(sysObjectID) {
  if (!sysObjectID) return null;

  // Ordena por prefixo mais longo primeiro
  const entries = Object.entries(OIDS.sysObjectIDMap)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [prefix, info] of entries) {
    if (sysObjectID.startsWith(prefix)) {
      return { ...info, sysObjectID, matched_prefix: prefix };
    }
  }

  return { vendor: 'Unknown', category: 'unknown', technology: 'unknown', sysObjectID };
}

/**
 * Retorna OIDs para um grupo específico.
 */
function getGroup(group) {
  return OIDS[group] || {};
}

/**
 * Retorna todos os OIDs de um grupo como array plano { name, oid }
 * para uso com snmpbulkwalk.
 */
function getOidList(group) {
  const g = OIDS[group];
  if (!g) return [];
  return Object.entries(g)
    .filter(([,v]) => typeof v === 'string')
    .map(([name, oid]) => ({ name, oid }));
}

module.exports = { OIDS, resolveSysObjectID, getGroup, getOidList };
