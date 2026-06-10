'use strict';

const NOW_ISO = () => new Date().toISOString();

function makeEdge(runId, fromId, toRef, type, protocol, source, confidence, evidence) {
  return {
    run_id: runId,
    from_asset_id: fromId,
    to_asset_ref: toRef,
    edge_type: type,
    protocol: protocol || 'unknown',
    source,
    confidence: typeof confidence === 'number' ? Number(confidence.toFixed(3)) : 0.5,
    evidence: Array.isArray(evidence) ? evidence : (evidence ? [evidence] : []),
    last_seen: NOW_ISO(),
  };
}

function buildTopologyEdges(runId, assets) {
  const edges = [];
  const uniq = new Set();

  const pushEdge = (edge) => {
    const key = `${edge.from_asset_id}|${edge.to_asset_ref}|${edge.edge_type}`;
    if (uniq.has(key)) return;
    uniq.add(key);
    edges.push(edge);
  };

  for (const asset of assets) {
    const ip = asset.primary_ip || 'unknown';

    // ------------------------------------------------------------------
    // 1. Edges baseados em serviços (porta aberta confirmada)
    // ------------------------------------------------------------------
    if (Array.isArray(asset.services)) {
      for (const svc of asset.services) {
        if (svc.container_id) {
          pushEdge(makeEdge(runId, asset.id, `container:${svc.container_id}`,
            'container_service', svc.protocol || 'tcp', 'active-discovery', 0.78,
            [{ type: 'container_id', value: svc.container_id }]
          ));
        }

        if (svc.dependency_target) {
          pushEdge(makeEdge(runId, asset.id, svc.dependency_target,
            'service_dependency', svc.protocol || 'tcp', 'active-discovery', 0.72,
            [{ type: 'dependency_declaration', value: svc.dependency_target }]
          ));
        }

        pushEdge(makeEdge(runId, asset.id, `${ip}:${svc.port}`,
          'host_service', svc.protocol || 'tcp', 'active-discovery', 0.65,
          [{ type: 'open_port', value: svc.port }]
        ));

        if ([9100, 9104, 9108, 9115, 9117, 9121, 9187, 9256, 9419, 9090, 9091].includes(svc.port)) {
          pushEdge(makeEdge(runId, asset.id, `exporter:${svc.port}`,
            'service_exporter', svc.protocol || 'tcp', 'active-discovery', 0.70,
            [{ type: 'exporter_port', value: svc.port }]
          ));
        }

        if ([3306, 5432].includes(svc.port)) {
          pushEdge(makeEdge(runId, asset.id, `database:${svc.port}`,
            'service_database', svc.protocol || 'tcp', 'active-discovery', 0.72,
            [{ type: 'database_port', value: svc.port }]
          ));
        }

        if (svc.port === 53) {
          pushEdge(makeEdge(runId, asset.id, 'dns:53',
            'service_dns', 'udp', 'active-discovery', 0.70,
            [{ type: 'dns_port', value: 53 }]
          ));
        }
      }
    }

    // ------------------------------------------------------------------
    // 2. Edges LLDP/CDP baseados em vizinhos SNMP reais
    // ------------------------------------------------------------------
    const snmpNeighbors = asset.snmp_neighbors || asset.scan_result?.snmp_neighbors || [];
    for (const neighbor of snmpNeighbors) {
      if (!neighbor || typeof neighbor !== 'string') continue;
      // Distinguir LLDP vs CDP pelo prefixo da evidência, se disponível
      const source = neighbor.startsWith('cdp:') ? 'snmp-cdp' : 'snmp-lldp';
      const cleanNeighbor = neighbor.replace(/^(lldp:|cdp:)/, '');
      pushEdge(makeEdge(runId, asset.id, `neighbor:${cleanNeighbor}`,
        source === 'snmp-cdp' ? 'cdp_neighbor' : 'lldp_neighbor',
        'ethernet', source, 0.82,
        [{ type: 'snmp_neighbor_discovery', value: cleanNeighbor, source }]
      ));
    }

    // ------------------------------------------------------------------
    // 3. Edges de interfaces SNMP (links físicos com ifIndex)
    // ------------------------------------------------------------------
    const snmpInterfaces = asset.snmp_interfaces || asset.scan_result?.snmp_interfaces || [];
    for (const iface of snmpInterfaces) {
      if (!iface || !iface.ifIndex) continue;
      const ifRef = `interface:${ip}:${iface.ifIndex}`;
      pushEdge(makeEdge(runId, asset.id, ifRef,
        'snmp_interface', 'ethernet', 'snmp-mib2', 0.75,
        [{ type: 'snmp_interface', ifIndex: iface.ifIndex, ifName: iface.ifName || null }]
      ));
    }

    // ------------------------------------------------------------------
    // 4. Edges de VLAN (agrupamento lógico)
    // ------------------------------------------------------------------
    const snmpVlans = asset.snmp_vlans || asset.scan_result?.snmp_vlans || [];
    for (const vlan of snmpVlans) {
      if (!vlan) continue;
      const vlanId = typeof vlan === 'object' ? (vlan.id || vlan.vlan || String(vlan)) : String(vlan);
      pushEdge(makeEdge(runId, asset.id, `vlan:${vlanId}`,
        'vlan_membership', 'l2', 'snmp-vlan-mib', 0.78,
        [{ type: 'vlan_id', value: vlanId }]
      ));
    }

    // ------------------------------------------------------------------
    // 5. Edge de gateway/default route (correlação ARP)
    // ------------------------------------------------------------------
    const topology = asset.topology_context || asset.topology || {};
    if (topology.gateway === true || topology.gateway_ip) {
      const gwRef = topology.gateway_ip ? `gateway:${topology.gateway_ip}` : 'gateway:default';
      pushEdge(makeEdge(runId, asset.id, gwRef,
        'gateway_route', 'ip', 'arp-discovery', 0.68,
        [{ type: 'default_gateway', value: topology.gateway_ip || 'default' }]
      ));
    }

    // ------------------------------------------------------------------
    // 6. Edge de correlação ARP (MAC→IP mapeado)
    // ------------------------------------------------------------------
    if (asset.mac_address && asset.primary_ip) {
      pushEdge(makeEdge(runId, asset.id, `arp:${asset.mac_address}`,
        'arp_correlation', 'ethernet', 'arp-table', 0.72,
        [{ type: 'arp_entry', mac: asset.mac_address, ip: asset.primary_ip }]
      ));
    }
  }

  return edges;
}

module.exports = { buildTopologyEdges };
