'use strict';

/**
 * MAC Address utilities for Discovery Engine.
 *
 * Detecta:
 *  - locally administered (LAA): bit 1 do primeiro octeto = 1
 *  - multicast: bit 0 do primeiro octeto = 1
 *  - global unicast (OUI): bit 1 e bit 0 = 0
 *
 * Referência: IEEE 802 MAC address structure
 *   Primeiro octeto: b0 (multicast) | b1 (locally administered) | b2-b7 (OUI)
 *
 * MAC localmente administrado NUNCA deve ser usado como fonte confiável
 * de vendor, pois o OUI não segue a base IEEE.
 */

const MAC_RE = /^([0-9a-f]{2}):([0-9a-f]{2}):([0-9a-f]{2}):([0-9a-f]{2}):([0-9a-f]{2}):([0-9a-f]{2})$/i;

/**
 * Normaliza MAC para lowercase com dois-pontos.
 * Retorna null se inválido.
 */
function normalizeMac(mac) {
  if (!mac) return null;
  const cleaned = String(mac).trim().toLowerCase().replace(/-/g, ':');
  return MAC_RE.test(cleaned) ? cleaned : null;
}

/**
 * Analisa o tipo de MAC address.
 *
 * @param {string} mac - MAC address (xx:xx:xx:xx:xx:xx)
 * @returns {{ mac_type: string, is_locally_administered: boolean, is_multicast: boolean, is_global_unicast: boolean, first_octet: number } | null}
 */
function analyzeMacType(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;

  const firstOctet = parseInt(normalized.split(':')[0], 16);
  const isMulticast = (firstOctet & 0x01) !== 0;
  const isLocallyAdministered = (firstOctet & 0x02) !== 0;

  let macType;
  if (isMulticast) {
    macType = 'multicast';
  } else if (isLocallyAdministered) {
    macType = 'locally_administered';
  } else {
    macType = 'global_unicast';
  }

  return {
    mac_type: macType,
    is_locally_administered: isLocallyAdministered,
    is_multicast: isMulticast,
    is_global_unicast: !isMulticast && !isLocallyAdministered,
    first_octet: firstOctet,
  };
}

/**
 * Verifica se o MAC é localmente administrado (LAA).
 * MACs LAA são gerados por software, containers, VMs, dispositivos móveis
 * com MAC aleatório, etc. O OUI destes MACs NÃO é confiável.
 */
function isLocallyAdministered(mac) {
  const analysis = analyzeMacType(mac);
  return analysis ? analysis.is_locally_administered : false;
}

/**
 * Retorna o vendor_reliable baseado no tipo de MAC.
 * Apenas MACs global unicast com OUI conhecido são confiáveis.
 *
 * @param {string} mac
 * @param {string|null} vendor - resultado do lookup
 * @returns {{ vendor_reliable: boolean, mac_type: string, reason: string }}
 */
function vendorReliability(mac, vendor) {
  const analysis = analyzeMacType(mac);

  if (!analysis) {
    return {
      vendor_reliable: false,
      mac_type: 'invalid',
      reason: 'MAC address invalid or unparseable',
    };
  }

  if (analysis.is_locally_administered) {
    return {
      vendor_reliable: false,
      mac_type: 'locally_administered',
      reason: 'MAC is locally administered — OUI does not follow IEEE assignment',
    };
  }

  if (analysis.is_multicast) {
    return {
      vendor_reliable: false,
      mac_type: 'multicast',
      reason: 'Multicast MAC — not a unicast device address',
    };
  }

  // Global unicast — OUI is meaningful
  if (!vendor || vendor === 'Unknown') {
    return {
      vendor_reliable: false,
      mac_type: 'global_unicast',
      reason: 'Vendor not found in OUI database',
    };
  }

  return {
    vendor_reliable: true,
    mac_type: 'global_unicast',
    reason: 'MAC is global unicast with known OUI',
  };
}

module.exports = {
  normalizeMac,
  analyzeMacType,
  isLocallyAdministered,
  vendorReliability,
  MAC_RE,
};
