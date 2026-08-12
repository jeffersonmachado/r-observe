'use strict';

/**
 * R-Observe Discovery — Infrastructure Classifier (Enterprise)
 *
 * Classifica hosts de infraestrutura com base em múltiplos sinais:
 *   - SNMP sysDescr / sysObjectID
 *   - SSH banner
 *   - HTTP Server header
 *   - TLS certificate subject/issuer
 *   - mDNS / SSDP / NetBIOS
 *   - Nmap OS fingerprint
 *   - MAC OUI
 *
 * Categorias suportadas:
 *   - Hypervisors: VMware ESXi, Proxmox VE, Hyper-V, XenServer, KVM
 *   - OS: Linux (distros), Windows Server, BSD (FreeBSD, OpenBSD), macOS
 *   - Docker / Kubernetes / OpenShift
 *   - Storage: NetApp, Synology, QNAP, FreeNAS/TrueNAS
 *   - Network OS: Cisco IOS/NX-OS, Juniper JunOS, ArubaOS, FortiOS, MikroTik RouterOS, pfSense/OPNsense
 *
 * Cada classificação retorna:
 *   - vendor, product, category, os_type, os_family
 *   - confidence_score (0.0 a 1.0)
 *   - evidence (array)
 *   - method
 *   - timestamp
 */

const { log } = require('../utils/logger');

// ─── Constants ───────────────────────────────────────────────────────────────

const DETECTION_METHODS = {
  SNMP_SYSDESCR: 'snmp_sysdescr',
  SNMP_SYSOBJECTID: 'snmp_sysobjectid',
  SSH_BANNER: 'ssh_banner',
  HTTP_SERVER: 'http_server',
  TLS_CERTIFICATE: 'tls_cert',
  NMAP_OS: 'nmap_os',
  MAC_OUI: 'mac_oui',
  MDNS: 'mdns',
  NETBIOS: 'netbios',
  HTTP_TITLE: 'http_title',
  DOCKER_API: 'docker_api',
};

// ─── Evidence Builder ────────────────────────────────────────────────────────

function nowIso() {
  return new Date().toISOString();
}

function clamp(v, min = 0, max = 1) {
  return Math.max(min, Math.min(max, v));
}

function makeEvidence(type, source, confidence, raw = null, normalized = {}) {
  return {
    evidence_type: type,
    evidence_source: source,
    confidence: clamp(confidence),
    raw_data: raw,
    normalized_data: normalized,
    timestamp: nowIso(),
  };
}

// ─── Hypervisor Classifier ───────────────────────────────────────────────────

const HYPERVISOR_SIGNATURES = [
  // VMware ESXi
  {
    product: 'VMware ESXi',
    vendor: 'VMware',
    category: 'hypervisor',
    technology: 'virtualization',
    os_family: 'vmware',
    signals: {
      snmp_sysdescr: [/VMware ESXi/i, /VMkernel/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.6876'],
      ssh_banner: [/VMware ESXi/i, /VMkernel/i],
      http_server: [/ESXi/, /VMware/],
      http_title: [/VMware ESXi/, /ESXi Welcome/],
      tls_subject: [/ESXi/, /VMware/],
      mac_oui: ['00:0C:29', '00:50:56', '00:05:69', '00:1C:14'],
      nmap_os: [/VMware ESXi/i, /VMware virtual/i],
      ports: [{ port: 443, protocol: 'tcp' }, { port: 902, protocol: 'tcp' }],
    },
    weight: 10,
  },
  // Proxmox VE
  {
    product: 'Proxmox VE',
    vendor: 'Proxmox',
    category: 'hypervisor',
    technology: 'virtualization',
    os_family: 'linux',
    signals: {
      snmp_sysdescr: [/Proxmox/i, /pve-manager/i],
      ssh_banner: [/Proxmox/i, /pve/i],
      http_server: [/pveproxy/, /Proxmox/],
      http_title: [/Proxmox Virtual Environment/i, /Proxmox VE/i],
      http_paths: ['/pve', '/api2/json'],
      tls_subject: [/Proxmox/i],
      port_8006: { protocol: 'tcp', service: 'Proxmox VE web' },
    },
    weight: 10,
  },
  // Microsoft Hyper-V
  {
    product: 'Hyper-V',
    vendor: 'Microsoft',
    category: 'hypervisor',
    technology: 'virtualization',
    os_family: 'windows',
    signals: {
      snmp_sysdescr: [/Hyper-V/i, /Windows.*Hyper/i],
      ssh_banner: [/Windows.*Hyper-V/i],
      netbios: [/HYPERV/i],
      http_server: [/Microsoft-IIS/, /Microsoft-HTTPAPI/],
      nmap_os: [/Windows Server.*Hyper-V/i, /Microsoft Windows Server/],
      ports: [{ port: 5985, protocol: 'tcp' }, { port: 5986, protocol: 'tcp' }],
    },
    weight: 8,
  },
  // KVM / QEMU (libvirt)
  {
    product: 'KVM/QEMU',
    vendor: 'Linux KVM',
    category: 'hypervisor',
    technology: 'virtualization',
    os_family: 'linux',
    signals: {
      snmp_sysdescr: [/KVM/i, /QEMU/i],
      process_hint: ['qemu-kvm', 'qemu-system'],
      nmap_os: [/KVM/i, /QEMU virtual/i],
      mac_oui: ['52:54:00'], // QEMU default MAC
    },
    weight: 5,
  },
  // XenServer / XCP-ng
  {
    product: 'XenServer',
    vendor: 'Citrix/XCP-ng',
    category: 'hypervisor',
    technology: 'virtualization',
    os_family: 'linux',
    signals: {
      snmp_sysdescr: [/XenServer/i, /XCP-ng/i, /xenenterprise/i],
      ssh_banner: [/XenServer/i, /XCP-ng/i],
      http_title: [/XenServer/i, /XCP-ng/i, /XenCenter/i],
      nmap_os: [/Xen virtual/i],
    },
    weight: 7,
  },
];

// ─── OS Classifier ───────────────────────────────────────────────────────────

const OS_SIGNATURES = [
  // Linux Distributions
  {
    product: 'Ubuntu Linux',
    vendor: 'Canonical',
    category: 'server',
    technology: 'operating_system',
    os_family: 'linux',
    os_type: 'ubuntu',
    signals: {
      snmp_sysdescr: [/Ubuntu/i],
      ssh_banner: [/Ubuntu/i],
      http_server: [/Ubuntu/i],
      tls_subject: [/Ubuntu/i],
      nmap_os: [/Ubuntu/i],
    },
    weight: 8,
  },
  {
    product: 'Debian Linux',
    vendor: 'Debian',
    category: 'server',
    technology: 'operating_system',
    os_family: 'linux',
    os_type: 'debian',
    signals: {
      snmp_sysdescr: [/Debian/i],
      ssh_banner: [/Debian/i],
      nmap_os: [/Debian/i],
    },
    weight: 8,
  },
  {
    product: 'CentOS/RHEL/Rocky Linux',
    vendor: 'Red Hat',
    category: 'server',
    technology: 'operating_system',
    os_family: 'linux',
    os_type: 'rhel',
    signals: {
      snmp_sysdescr: [/CentOS/i, /Red Hat/i, /Rocky Linux/i, /AlmaLinux/i, /Fedora/i],
      ssh_banner: [/CentOS/i, /Red Hat/i, /Rocky/i, /AlmaLinux/i],
      nmap_os: [/CentOS/i, /Red Hat/i, /Fedora/i],
    },
    weight: 8,
  },
  {
    product: 'Alpine Linux',
    vendor: 'Alpine',
    category: 'server',
    technology: 'operating_system',
    os_family: 'linux',
    os_type: 'alpine',
    signals: {
      snmp_sysdescr: [/Alpine/i],
      ssh_banner: [/Alpine/i],
      nmap_os: [/Alpine Linux/i],
    },
    weight: 7,
  },
  {
    product: 'SUSE Linux',
    vendor: 'SUSE',
    category: 'server',
    technology: 'operating_system',
    os_family: 'linux',
    os_type: 'suse',
    signals: {
      snmp_sysdescr: [/SUSE/i, /openSUSE/i],
      ssh_banner: [/SUSE/i],
      nmap_os: [/SUSE/i],
    },
    weight: 7,
  },
  // Windows
  {
    product: 'Windows Server',
    vendor: 'Microsoft',
    category: 'server',
    technology: 'operating_system',
    os_family: 'windows',
    os_type: 'windows_server',
    signals: {
      snmp_sysdescr: [/Windows Server/i, /Windows 2008/i, /Windows 2012/i, /Windows 2016/i, /Windows 2019/i, /Windows 2022/i],
      ssh_banner: [/Windows/i],
      http_server: [/Microsoft-IIS/, /Microsoft-HTTPAPI/],
      netbios: [/WORKGROUP/, /DOMAIN/],
      smb: true,
      nmap_os: [/Windows Server/i, /Windows 10/i, /Windows 11/i],
      ports: [{ port: 445, protocol: 'tcp' }, { port: 135, protocol: 'tcp' }, { port: 3389, protocol: 'tcp' }],
    },
    weight: 9,
  },
  // BSD
  {
    product: 'FreeBSD',
    vendor: 'FreeBSD',
    category: 'server',
    technology: 'operating_system',
    os_family: 'bsd',
    os_type: 'freebsd',
    signals: {
      snmp_sysdescr: [/FreeBSD/i],
      ssh_banner: [/FreeBSD/i],
      nmap_os: [/FreeBSD/i],
    },
    weight: 8,
  },
  {
    product: 'OpenBSD',
    vendor: 'OpenBSD',
    category: 'server',
    technology: 'operating_system',
    os_family: 'bsd',
    os_type: 'openbsd',
    signals: {
      snmp_sysdescr: [/OpenBSD/i],
      ssh_banner: [/OpenBSD/i],
      nmap_os: [/OpenBSD/i],
    },
    weight: 7,
  },
  // pfSense / OPNsense
  {
    product: 'pfSense',
    vendor: 'Netgate',
    category: 'firewall',
    technology: 'operating_system',
    os_family: 'bsd',
    os_type: 'pfsense',
    signals: {
      snmp_sysdescr: [/pfSense/i],
      ssh_banner: [/pfSense/i],
      http_server: [/nginx/],
      http_title: [/pfSense/i, /Netgate pfSense Plus/i],
      http_paths: ['/', '/pfsense'],
      tls_subject: [/pfSense/i],
    },
    weight: 9,
  },
  {
    product: 'OPNsense',
    vendor: 'Deciso',
    category: 'firewall',
    technology: 'operating_system',
    os_family: 'bsd',
    os_type: 'opnsense',
    signals: {
      snmp_sysdescr: [/OPNsense/i],
      ssh_banner: [/OPNsense/i],
      http_title: [/OPNsense/i],
      tls_subject: [/OPNsense/i],
    },
    weight: 8,
  },
  // TrueNAS / FreeNAS
  {
    product: 'TrueNAS',
    vendor: 'iXsystems',
    category: 'storage',
    technology: 'operating_system',
    os_family: 'bsd',
    os_type: 'truenas',
    signals: {
      snmp_sysdescr: [/TrueNAS/i, /FreeNAS/i],
      ssh_banner: [/TrueNAS/i, /FreeNAS/i],
      http_server: [/nginx/],
      http_title: [/TrueNAS/i, /FreeNAS/i],
      http_paths: ['/ui', '/api'],
      tls_subject: [/TrueNAS/i, /FreeNAS/i],
    },
    weight: 9,
  },
];

// ─── Network OS Classifier ───────────────────────────────────────────────────

const NETWORK_OS_SIGNATURES = [
  {
    product: 'Cisco IOS',
    vendor: 'Cisco',
    category: 'network_device',
    technology: 'router',
    os_family: 'cisco_ios',
    signals: {
      snmp_sysdescr: [/Cisco IOS/i, /Cisco Internetwork Operating System/i, /IOS Software/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.9.1'],
      ssh_banner: [/Cisco/i, /IOS/i],
      nmap_os: [/Cisco IOS/i],
      ports: [{ port: 22, protocol: 'tcp' }, { port: 23, protocol: 'tcp' }],
    },
    weight: 10,
  },
  {
    product: 'Cisco NX-OS',
    vendor: 'Cisco',
    category: 'network_device',
    technology: 'switch',
    os_family: 'cisco_nxos',
    signals: {
      snmp_sysdescr: [/Cisco NX-OS/i, /Nexus/i],
      ssh_banner: [/Cisco NX-OS/i, /Nexus/i],
      nmap_os: [/Cisco NX-OS/i],
    },
    weight: 10,
  },
  {
    product: 'MikroTik RouterOS',
    vendor: 'MikroTik',
    category: 'network_device',
    technology: 'router',
    os_family: 'mikrotik',
    signals: {
      snmp_sysdescr: [/MikroTik/i, /RouterOS/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.14988.1'],
      ssh_banner: [/MikroTik/i, /RouterOS/i],
      http_server: [/MikroTik/, /RouterOS/],
      http_title: [/MikroTik/, /RouterOS/, /Winbox/],
      http_paths: ['/winbox', '/webfig'],
      nmap_os: [/MikroTik/i],
      mac_oui: ['00:0C:42', '08:55:31', '18:FD:74', '2C:C8:1B', '4C:5E:0C', '64:D1:54', '6C:3B:6B', '74:4D:28', 'B8:69:F4', 'CC:2D:E0', 'D4:01:C3', 'D4:CA:6D', 'DC:2C:6E', 'E4:8D:8C'],
      ports: [{ port: 8291, protocol: 'tcp' }, { port: 8728, protocol: 'tcp' }],
    },
    weight: 10,
  },
  {
    product: 'FortiOS',
    vendor: 'Fortinet',
    category: 'firewall',
    technology: 'security',
    os_family: 'fortios',
    signals: {
      snmp_sysdescr: [/FortiGate/i, /FortiOS/i, /Fortinet/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.12356'],
      ssh_banner: [/FortiGate/i],
      http_server: [/Fortinet/, /FortiGate/],
      http_title: [/FortiGate/i, /Fortinet/],
      tls_subject: [/FortiGate/i, /Fortinet/],
      ports: [{ port: 443, protocol: 'tcp' }, { port: 8443, protocol: 'tcp' }, { port: 10443, protocol: 'tcp' }],
    },
    weight: 10,
  },
  {
    product: 'Juniper JunOS',
    vendor: 'Juniper',
    category: 'network_device',
    technology: 'router',
    os_family: 'junos',
    signals: {
      snmp_sysdescr: [/Juniper/i, /JunOS/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.2636'],
      ssh_banner: [/Juniper/i, /JunOS/i],
      nmap_os: [/Juniper/i],
    },
    weight: 9,
  },
  {
    product: 'ArubaOS',
    vendor: 'Aruba/HPE',
    category: 'network_device',
    technology: 'wireless',
    os_family: 'arubaos',
    signals: {
      snmp_sysdescr: [/Aruba/i, /ArubaOS/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.14823'],
      ssh_banner: [/Aruba/i],
      http_title: [/Aruba/i],
      ports: [{ port: 4343, protocol: 'tcp' }],
    },
    weight: 9,
  },
  {
    product: 'Ubiquiti UniFi',
    vendor: 'Ubiquiti',
    category: 'network_device',
    technology: 'wireless',
    os_family: 'unifi',
    signals: {
      snmp_sysdescr: [/Ubiquiti/i, /UniFi/i, /UAP/i, /USW/i, /USG/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.41112'],
      ssh_banner: [/Ubiquiti/i],
      http_server: [/UniFi/, /Ubiquiti/],
      http_title: [/UniFi/i, /Ubiquiti/],
      tls_subject: [/UniFi/i, /Ubiquiti/],
      ports: [{ port: 8443, protocol: 'tcp' }, { port: 8080, protocol: 'tcp' }],
    },
    weight: 10,
  },
  {
    product: 'Dell EMC Networking',
    vendor: 'Dell',
    category: 'network_device',
    technology: 'switch',
    os_family: 'dell_os',
    signals: {
      snmp_sysdescr: [/Dell Networking/i, /Dell EMC/i, /PowerSwitch/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.674'],
      ssh_banner: [/Dell/i],
    },
    weight: 8,
  },
  {
    product: 'Palo Alto PAN-OS',
    vendor: 'Palo Alto',
    category: 'firewall',
    technology: 'security',
    os_family: 'panos',
    signals: {
      snmp_sysdescr: [/PAN-OS/i, /Palo Alto/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.25461'],
      ssh_banner: [/PAN-OS/i],
      http_title: [/Palo Alto/i],
      ports: [{ port: 443, protocol: 'tcp' }, { port: 4443, protocol: 'tcp' }],
    },
    weight: 9,
  },
];

// ─── Container/Platform Classifier ───────────────────────────────────────────

const CONTAINER_SIGNATURES = [
  {
    product: 'Docker Host',
    vendor: 'Docker Inc.',
    category: 'container_platform',
    technology: 'container',
    os_family: 'linux',
    signals: {
      ssh_banner: [/Docker/i],
      http_server: [/Docker/i],
      docker_socket: true,
      process_hint: ['dockerd', 'containerd'],
      ports: [{ port: 2375, protocol: 'tcp' }, { port: 2376, protocol: 'tcp' }],
    },
    weight: 7,
  },
  {
    product: 'Kubernetes',
    vendor: 'CNCF',
    category: 'container_platform',
    technology: 'orchestration',
    os_family: 'linux',
    signals: {
      http_server: [/kube-apiserver/i],
      http_paths: ['/api', '/api/v1', '/version'],
      tls_subject: [/kubernetes/i, /kube-apiserver/i],
      ports: [{ port: 6443, protocol: 'tcp' }, { port: 443, protocol: 'tcp' }],
    },
    weight: 8,
  },
  {
    product: 'OpenShift',
    vendor: 'Red Hat',
    category: 'container_platform',
    technology: 'orchestration',
    os_family: 'linux',
    signals: {
      snmp_sysdescr: [/OpenShift/i],
      http_server: [/OpenShift/i],
      http_title: [/OpenShift/i],
      http_paths: ['/console', '/api'],
      tls_subject: [/openshift/i],
    },
    weight: 8,
  },
];

// ─── Storage Classifier ─────────────────────────────────────────────────────

const STORAGE_SIGNATURES = [
  {
    product: 'Synology NAS',
    vendor: 'Synology',
    category: 'storage',
    technology: 'nas',
    os_family: 'linux',
    signals: {
      snmp_sysdescr: [/Synology/i, /DSM/i],
      ssh_banner: [/Synology/i],
      http_server: [/nginx/],
      http_title: [/Synology/i, /DiskStation/i],
      http_paths: ['/webman', '/dsm'],
      tls_subject: [/Synology/i],
      ports: [{ port: 5000, protocol: 'tcp' }, { port: 5001, protocol: 'tcp' }],
    },
    weight: 10,
  },
  {
    product: 'QNAP NAS',
    vendor: 'QNAP',
    category: 'storage',
    technology: 'nas',
    os_family: 'linux',
    signals: {
      snmp_sysdescr: [/QNAP/i, /QTS/i],
      ssh_banner: [/QNAP/i],
      http_title: [/QNAP/i, /QTS/i],
      http_paths: ['/cgi-bin'],
      ports: [{ port: 8080, protocol: 'tcp' }, { port: 443, protocol: 'tcp' }],
    },
    weight: 9,
  },
  {
    product: 'NetApp ONTAP',
    vendor: 'NetApp',
    category: 'storage',
    technology: 'san',
    os_family: 'netapp',
    signals: {
      snmp_sysdescr: [/NetApp/i, /ONTAP/i],
      snmp_sysobjectid: ['.1.3.6.1.4.1.789'],
      ssh_banner: [/NetApp/i],
      http_title: [/NetApp/i, /ONTAP/i],
    },
    weight: 9,
  },
];

// ─── Matcher Engine ──────────────────────────────────────────────────────────

function collectTextSignals(signals) {
  return [
    signals.snmp_sysdescr,
    signals.ssh_banner,
    signals.http_server,
    signals.http_title,
    signals.tls_subject,
    signals.tls_issuer,
    signals.hostname,
    signals.netbios_name,
    signals.mdns_service,
  ].filter(Boolean);
}

function matchSignature(signature, signals) {
  let score = 0;
  let maxScore = 0;
  const evidence = [];
  const s = signature.signals;

  // SNMP sysDescr
  if (s.snmp_sysdescr && signals.snmp_sysdescr) {
    maxScore += 3;
    for (const re of s.snmp_sysdescr) {
      if (re.test(String(signals.snmp_sysdescr))) {
        score += 3;
        evidence.push(makeEvidence(DETECTION_METHODS.SNMP_SYSDESCR, 'infra-classifier', 0.9,
          signals.snmp_sysdescr, { match: re.toString(), product: signature.product }));
        break;
      }
    }
  }

  // SNMP sysObjectID
  if (s.snmp_sysobjectid && signals.snmp_sysobjectid) {
    maxScore += 4;
    for (const oid of s.snmp_sysobjectid) {
      if (String(signals.snmp_sysobjectid).startsWith(oid)) {
        score += 4;
        evidence.push(makeEvidence(DETECTION_METHODS.SNMP_SYSOBJECTID, 'infra-classifier', 0.95,
          signals.snmp_sysobjectid, { oid_match: oid, product: signature.product }));
        break;
      }
    }
  }

  // SSH Banner
  if (s.ssh_banner && signals.ssh_banner) {
    maxScore += 3;
    for (const re of s.ssh_banner) {
      if (re.test(String(signals.ssh_banner))) {
        score += 3;
        evidence.push(makeEvidence(DETECTION_METHODS.SSH_BANNER, 'infra-classifier', 0.85,
          signals.ssh_banner, { match: re.toString(), product: signature.product }));
        break;
      }
    }
  }

  // HTTP Server
  if (s.http_server && signals.http_server) {
    maxScore += 2;
    for (const re of s.http_server) {
      if (re.test(String(signals.http_server))) {
        score += 2;
        evidence.push(makeEvidence(DETECTION_METHODS.HTTP_SERVER, 'infra-classifier', 0.75,
          signals.http_server, { match: re.toString(), product: signature.product }));
        break;
      }
    }
  }

  // HTTP Title
  if (s.http_title && signals.http_title) {
    maxScore += 2;
    for (const re of s.http_title) {
      if (re.test(String(signals.http_title))) {
        score += 2;
        evidence.push(makeEvidence(DETECTION_METHODS.HTTP_TITLE, 'infra-classifier', 0.8,
          signals.http_title, { match: re.toString(), product: signature.product }));
        break;
      }
    }
  }

  // TLS Certificate
  if (s.tls_subject && signals.tls_subject) {
    maxScore += 2;
    for (const re of s.tls_subject) {
      if (re.test(String(signals.tls_subject))) {
        score += 2;
        evidence.push(makeEvidence(DETECTION_METHODS.TLS_CERTIFICATE, 'infra-classifier', 0.7,
          signals.tls_subject, { match: re.toString(), product: signature.product }));
        break;
      }
    }
  }

  // MAC OUI
  if (s.mac_oui && signals.mac_address) {
    maxScore += 2;
    const macPrefix = String(signals.mac_address).toUpperCase().replace(/[:-]/g, '').slice(0, 6);
    for (const oui of s.mac_oui) {
      if (macPrefix.startsWith(oui.replace(/[:-]/g, '').toUpperCase())) {
        score += 2;
        evidence.push(makeEvidence(DETECTION_METHODS.MAC_OUI, 'infra-classifier', 0.7,
          signals.mac_address, { oui_match: oui, product: signature.product }));
        break;
      }
    }
  }

  // Nmap OS
  if (s.nmap_os && signals.nmap_os) {
    maxScore += 3;
    for (const re of s.nmap_os) {
      if (re.test(String(signals.nmap_os))) {
        score += 3;
        evidence.push(makeEvidence(DETECTION_METHODS.NMAP_OS, 'infra-classifier', 0.8,
          signals.nmap_os, { match: re.toString(), product: signature.product }));
        break;
      }
    }
  }

  // Port check
  if (s.ports && signals.open_ports) {
    maxScore += 1;
    const openPortSet = new Set(signals.open_ports.map(p => typeof p === 'number' ? p : p.port));
    const matchedPorts = s.ports.filter(p => openPortSet.has(p.port));
    if (matchedPorts.length > 0) {
      score += 1;
      evidence.push(makeEvidence('port_match', 'infra-classifier', 0.6,
        matchedPorts, { product: signature.product }));
    }
  }

  // Special port checks (non-standard HTTP ports)
  if (s.port_8006 && signals.open_ports && signals.open_ports.some(p => (typeof p === 'number' ? p : p.port) === 8006)) {
    maxScore += 2;
    score += 2;
    evidence.push(makeEvidence('port_match', 'infra-classifier', 0.85,
      { port: 8006 }, { product: 'Proxmox VE', service: 'Proxmox VE web' }));
  }

  if (score > 0 && maxScore > 0) {
    return {
      vendor: signature.vendor,
      product: signature.product,
      category: signature.category,
      technology: signature.technology,
      os_family: signature.os_family || null,
      os_type: signature.os_type || null,
      confidence_score: Math.round((score / maxScore) * 100) / 100,
      evidence,
      weight: signature.weight,
    };
  }

  return null;
}

// ─── Main Classification Function ────────────────────────────────────────────

/**
 * @param {object} signals
 *   - snmp_sysdescr: string
 *   - snmp_sysobjectid: string
 *   - ssh_banner: string
 *   - http_server: string
 *   - http_title: string
 *   - tls_subject: string
 *   - tls_issuer: string
 *   - hostname: string
 *   - mac_address: string
 *   - nmap_os: string
 *   - netbios_name: string
 *   - mdns_service: string
 *   - open_ports: array
 *   - smb: boolean (indicativo de porta 445 aberta)
 * @returns {object}
 */
function classifyInfrastructure(signals = {}) {
  const allSignatures = [
    ...HYPERVISOR_SIGNATURES,
    ...NETWORK_OS_SIGNATURES,
    ...OS_SIGNATURES,
    ...CONTAINER_SIGNATURES,
    ...STORAGE_SIGNATURES,
  ];

  const matches = [];

  for (const sig of allSignatures) {
    const result = matchSignature(sig, signals);
    if (result) matches.push(result);
  }

  // Sort by confidence * weight desc
  matches.sort((a, b) => (b.confidence_score * b.weight) - (a.confidence_score * a.weight));

  // Determine best match and alternative matches
  const best = matches[0] || null;
  const alternatives = matches.slice(1, 4);

  return {
    best_match: best,
    alternatives,
    all_matches: matches,
    signals_used: collectTextSignals(signals),
    timestamp: nowIso(),
  };
}

module.exports = {
  classifyInfrastructure,
  HYPERVISOR_SIGNATURES,
  OS_SIGNATURES,
  NETWORK_OS_SIGNATURES,
  CONTAINER_SIGNATURES,
  STORAGE_SIGNATURES,
  DETECTION_METHODS,
};
