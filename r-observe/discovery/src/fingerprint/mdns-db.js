'use strict';

/**
 * Base de conhecimento de serviços mDNS e padrões SSDP.
 * Cada entrada define o que um serviço/padrão implica sobre o dispositivo.
 *
 * Estrutura: { vendor, product, category, technology, asset_type }
 */

// ─── mDNS Service Types ────────────────────────────────────────────────────
const MDNS_SERVICES = {
  // Apple
  '_airplay._tcp':          { vendor: null,     product: 'AirPlay Device',        category: 'media',   technology: 'airplay',    asset_type: 'media_device' },
  '_raop._tcp':             { vendor: 'Apple',  product: 'AirPlay Audio',         category: 'media',   technology: 'airplay',    asset_type: 'media_device' },
  '_appletv._tcp':          { vendor: 'Apple',  product: 'Apple TV',              category: 'media',   technology: 'appletv',    asset_type: 'media_device' },
  '_homekit._tcp':          { vendor: 'Apple',  product: 'HomeKit Device',        category: 'iot',     technology: 'homekit',    asset_type: 'iot' },
  '_companion-link._tcp':   { vendor: 'Apple',  product: 'iPhone/Apple Watch',    category: 'mobile',  technology: 'ios',        asset_type: 'mobile' },
  '_airdrop._tcp':          { vendor: 'Apple',  product: 'iPhone/Mac',            category: 'mobile',  technology: 'ios',        asset_type: 'mobile' },
  '_continuity._tcp':       { vendor: 'Apple',  product: 'Mac/iPhone',            category: 'mobile',  technology: 'ios',        asset_type: 'mobile' },
  '_sleep-proxy._udp':      { vendor: 'Apple',  product: 'Mac/Apple Device',      category: 'host',    technology: 'macos',      asset_type: 'host' },

  // Google / Android
  '_googlecast._tcp':       { vendor: 'Google', product: 'Chromecast/Cast Device',category: 'media',   technology: 'chromecast', asset_type: 'media_device' },
  '_androidtvremote._tcp':  { vendor: null,     product: 'Android TV',            category: 'media',   technology: 'androidtv',  asset_type: 'media_device' },
  '_androidtvremote2._tcp': { vendor: null,     product: 'Android TV',            category: 'media',   technology: 'androidtv',  asset_type: 'media_device' },
  '_matter._tcp':           { vendor: null,     product: 'Matter Smart Home',     category: 'iot',     technology: 'matter',     asset_type: 'iot' },
  '_android._tcp':          { vendor: null,     product: 'Smartphone Android',    category: 'mobile',  technology: 'android',    asset_type: 'mobile' },

  // Media / DLNA
  '_upnp._tcp':             { vendor: null,     product: 'UPnP Device',           category: 'media',   technology: 'upnp',       asset_type: 'iot' },
  '_daap._tcp':             { vendor: null,     product: 'iTunes/Music Library',  category: 'media',   technology: 'daap',       asset_type: 'host' },
  '_dacp._tcp':             { vendor: null,     product: 'iTunes Remote',         category: 'media',   technology: 'itunes',     asset_type: 'host' },

  // Impressoras
  '_ipp._tcp':              { vendor: null,     product: 'Impressora IPP',        category: 'printer', technology: 'ipp',        asset_type: 'iot' },
  '_ipps._tcp':             { vendor: null,     product: 'Impressora IPP/S',      category: 'printer', technology: 'ipp',        asset_type: 'iot' },
  '_printer._tcp':          { vendor: null,     product: 'Impressora',            category: 'printer', technology: 'printer',    asset_type: 'iot' },
  '_pdl-datastream._tcp':   { vendor: null,     product: 'Impressora HP/Kyocera', category: 'printer', technology: 'printer',    asset_type: 'iot' },
  '_scanner._tcp':          { vendor: null,     product: 'Scanner de Rede',       category: 'printer', technology: 'scanner',    asset_type: 'iot' },
  '_uscan._tcp':            { vendor: null,     product: 'Scanner USB/Rede',      category: 'printer', technology: 'scanner',    asset_type: 'iot' },

  // IoT / Smart Home
  '_hue._tcp':              { vendor: 'Philips',product: 'Philips Hue Bridge',    category: 'iot',     technology: 'hue',        asset_type: 'iot' },
  '_miio._udp':             { vendor: 'Xiaomi', product: 'Xiaomi IoT Device',     category: 'iot',     technology: 'miio',       asset_type: 'iot' },
  '_shelly._tcp':           { vendor: 'Shelly', product: 'Shelly Smart Relay',    category: 'iot',     technology: 'shelly',     asset_type: 'iot' },
  '_tuya._tcp':             { vendor: 'Tuya',   product: 'Tuya Smart Device',     category: 'iot',     technology: 'tuya',       asset_type: 'iot' },
  '_spotify-connect._tcp':  { vendor: 'Spotify',product: 'Spotify Connect Device',category: 'media',   technology: 'spotify',    asset_type: 'iot' },

  // Infraestrutura / Servidores
  '_http._tcp':             { vendor: null,     product: 'HTTP Service',          category: 'web',     technology: 'http',       asset_type: 'host' },
  '_https._tcp':            { vendor: null,     product: 'HTTPS Service',         category: 'web',     technology: 'http',       asset_type: 'host' },
  '_ssh._tcp':              { vendor: null,     product: 'SSH Host',              category: 'infra',   technology: 'ssh',        asset_type: 'host' },
  '_smb._tcp':              { vendor: null,     product: 'Servidor de Arquivos',  category: 'infra',   technology: 'smb',        asset_type: 'host' },
  '_afpovertcp._tcp':       { vendor: 'Apple',  product: 'Mac File Server',       category: 'infra',   technology: 'afp',        asset_type: 'host' },
  '_workstation._tcp':      { vendor: null,     product: 'Estação de Trabalho',   category: 'host',    technology: 'avahi',      asset_type: 'host' },
  '_device-info._tcp':      { vendor: null,     product: 'Dispositivo de Rede',   category: 'iot',     technology: 'mdns',       asset_type: 'iot' },

  // VoIP / VOIP
  '_sip._tcp':              { vendor: null,     product: 'SIP Endpoint',          category: 'voice',   technology: 'sip',        asset_type: 'iot' },
  '_sip._udp':              { vendor: null,     product: 'SIP Endpoint',          category: 'voice',   technology: 'sip',        asset_type: 'iot' },
};

// ─── SSDP Server String Patterns ──────────────────────────────────────────
// Testados em ordem — primeiro match vence
const SSDP_SERVER_PATTERNS = [
  // Linux com stack UPnP (Avahi, minidlna, etc.) — antes de regras genéricas DLNA
  { re: /linux.+avahi/i,        result: { vendor: null,       product: 'Linux Host',           category: 'host',    technology: 'linux',    asset_type: 'host' } },
  { re: /linux.+minidlna/i,     result: { vendor: null,       product: 'Linux Media Server',   category: 'media',   technology: 'linux',    asset_type: 'host' } },
  { re: /linux.+kodi/i,         result: { vendor: null,       product: 'Kodi Media Center',    category: 'media',   technology: 'kodi',     asset_type: 'host' } },
  { re: /\blinux\b/i,           result: { vendor: null,       product: 'Linux Host',           category: 'host',    technology: 'linux',    asset_type: 'host' } },
  { re: /\bwindows\b.+upnp/i,   result: { vendor: 'Microsoft',product: 'Windows Host',         category: 'host',    technology: 'windows',  asset_type: 'host' } },
  { re: /mac os x/i,            result: { vendor: 'Apple',    product: 'macOS Host',           category: 'host',    technology: 'macos',    asset_type: 'host' } },

  // Smart TVs e media players
  { re: /hisense|his\/\d/i,     result: { vendor: 'Hisense',  product: 'Smart TV Hisense',     category: 'media',   technology: 'upnp-media', asset_type: 'media_device' } },
  { re: /samsung.*tv|tizen/i,   result: { vendor: 'Samsung',  product: 'Smart TV Samsung',     category: 'media',   technology: 'upnp-media', asset_type: 'media_device' } },
  { re: /lg\s*(electronics|webos|tv)/i, result: { vendor: 'LG', product: 'Smart TV LG',        category: 'media',   technology: 'upnp-media', asset_type: 'media_device' } },
  { re: /sony.*tv|bravia/i,     result: { vendor: 'Sony',     product: 'Smart TV Sony',        category: 'media',   technology: 'upnp-media', asset_type: 'media_device' } },
  { re: /philips.*tv/i,         result: { vendor: 'Philips',  product: 'Smart TV Philips',     category: 'media',   technology: 'upnp-media', asset_type: 'media_device' } },
  { re: /panasonic/i,           result: { vendor: 'Panasonic',product: 'TV Panasonic',         category: 'media',   technology: 'upnp-media', asset_type: 'media_device' } },
  { re: /roku/i,                result: { vendor: 'Roku',     product: 'Roku Streaming',       category: 'media',   technology: 'roku',     asset_type: 'media_device' } },
  { re: /fire tv|amazon/i,      result: { vendor: 'Amazon',   product: 'Amazon Fire TV',       category: 'media',   technology: 'firetv',   asset_type: 'media_device' } },
  { re: /apple tv/i,            result: { vendor: 'Apple',    product: 'Apple TV',             category: 'media',   technology: 'appletv',  asset_type: 'media_device' } },

  // Roteadores / APs
  { re: /mikrotik/i,            result: { vendor: 'MikroTik', product: 'Roteador MikroTik',    category: 'router',  technology: 'mikrotik', asset_type: 'network_device' } },
  { re: /asus.*rt|asuswrt/i,    result: { vendor: 'ASUS',     product: 'Roteador ASUS',        category: 'router',  technology: 'asus',     asset_type: 'network_device' } },
  { re: /openwrt/i,             result: { vendor: null,       product: 'OpenWRT Router',        category: 'router',  technology: 'openwrt',  asset_type: 'network_device' } },
  { re: /dd-wrt/i,              result: { vendor: null,       product: 'DD-WRT Router',         category: 'router',  technology: 'ddwrt',    asset_type: 'network_device' } },
  { re: /ubiquiti|unifi/i,      result: { vendor: 'Ubiquiti', product: 'Access Point Ubiquiti', category: 'ap',      technology: 'ubiquiti', asset_type: 'network_device' } },
  { re: /cisco/i,               result: { vendor: 'Cisco',    product: 'Cisco Network Device',  category: 'switch',  technology: 'cisco',    asset_type: 'network_device' } },

  // Impressoras
  { re: /hp.*laserjet|hp.*officejet|hp.*deskjet/i, result: { vendor: 'HP', product: 'Impressora HP', category: 'printer', technology: 'printer', asset_type: 'iot' } },
  { re: /canon/i,               result: { vendor: 'Canon',    product: 'Impressora Canon',      category: 'printer', technology: 'printer',  asset_type: 'iot' } },
  { re: /epson/i,               result: { vendor: 'Epson',    product: 'Impressora Epson',      category: 'printer', technology: 'printer',  asset_type: 'iot' } },
  { re: /xerox/i,               result: { vendor: 'Xerox',    product: 'Impressora Xerox',      category: 'printer', technology: 'printer',  asset_type: 'iot' } },

  // Generic DLNA/UPnP — último recurso (depois de todos os fabricantes específicos)
  { re: /dlnadoc|mediarenderer|mediaserver/i, result: { vendor: null, product: 'TV / Media Device', category: 'media', technology: 'upnp-media', asset_type: 'media_device' } },
  { re: /upnp/i,                result: { vendor: null,       product: 'UPnP Device',           category: 'iot',     technology: 'upnp',     asset_type: 'iot' } },
];

// ─── API Pública ───────────────────────────────────────────────────────────

/**
 * Consulta banco mDNS pelo tipo de serviço.
 * @param {string} serviceType - ex: "_googlecast._tcp"
 * @returns {{ vendor, product, category, technology, asset_type }|null}
 */
function lookupMdnsService(serviceType) {
  if (!serviceType) return null;
  const key = serviceType.toLowerCase().trim();
  return MDNS_SERVICES[key] || null;
}

/**
 * Consulta banco SSDP pelo server string.
 * @param {string} serverString - ex: "Linux/6.8.0 UPnP/1.1 Avahi/0.8"
 * @returns {{ vendor, product, category, technology, asset_type }|null}
 */
function lookupSsdpServer(serverString) {
  if (!serverString) return null;
  for (const { re, result } of SSDP_SERVER_PATTERNS) {
    if (re.test(serverString)) return result;
  }
  return null;
}

/**
 * Resolve o melhor match a partir de múltiplos serviços mDNS.
 * Prioriza serviços mais específicos (menor index = maior especificidade).
 */
function resolveFromMdnsServices(serviceList) {
  if (!Array.isArray(serviceList) || !serviceList.length) return null;
  for (const svc of serviceList) {
    const match = lookupMdnsService(svc);
    if (match) return match;
  }
  return null;
}

module.exports = { lookupMdnsService, lookupSsdpServer, resolveFromMdnsServices };
