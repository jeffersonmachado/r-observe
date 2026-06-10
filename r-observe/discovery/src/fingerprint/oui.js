'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { log } = require('../utils/logger');

const CACHE_PATH    = path.join(require('os').tmpdir(), 'oui-cache.json');
const REFRESH_MS    = 7 * 24 * 60 * 60 * 1000; // 7 dias
const IEEE_OUI_URL  = 'https://standards-oui.ieee.org/oui/oui.csv';

// Fallback embutido para os fabricantes mais comuns (garante funcionamento offline)
const BUILTIN_OUI = {
  '00:1B:44': 'MikroTik',
  '24:A4:3C': 'Intelbras',
  '3C:5A:B4': 'Hikvision',
  'F0:AD:4E': 'Grandstream',
  'AC:DE:48': 'ControlID',
  'A0:AF:BD': 'Samsung',
  'F4:42:8F': 'Samsung',
  '2C:4D:54': 'Samsung',
  'AC:5F:3E': 'Samsung',
  'B8:C6:81': 'Apple',
  'F4:DB:E6': 'Apple',
  'A8:86:DD': 'Apple',
  'A4:C4:94': 'Xiaomi',
  '00:9E:C8': 'Xiaomi',
  '28:6C:07': 'Xiaomi',
  'B0:72:BF': 'Motorola',
  'CC:9F:7A': 'Motorola',
  '00:24:E8': 'Motorola',
  'F8:A2:D6': 'Google',
  '3C:28:6D': 'Google',
  'A4:77:33': 'Google',
  '50:BA:02': 'Motorola/Hisense',
  'A5:08:91': 'Hisense',
  '00:17:88': 'Philips Hue',
  'EC:FA:BC': 'Amazon',
  'FC:A1:83': 'Amazon',
  '74:75:48': 'Amazon',
  '18:B4:30': 'Nest/Google',
  '64:16:66': 'Intelbras',
};

let _ouiMap = new Map(Object.entries(BUILTIN_OUI));
let _lastFetch = 0;
let _fetchInProgress = false;

function normPrefix(mac) {
  return String(mac || '')
    .toUpperCase()
    .replace(/-/g, ':')
    .split(':')
    .slice(0, 3)
    .join(':');
}

// Parseia CSV da IEEE: "MA-L","XXXXXX","Vendor Name","address..."
function parseOuiCsv(csv) {
  const map = new Map();
  for (const line of csv.split('\n').slice(1)) {
    const cols = line.split(',');
    if (cols.length < 3) continue;
    const hex = (cols[1] || '').replace(/"/g, '').trim();
    const vendor = (cols[2] || '').replace(/"/g, '').trim();
    if (hex.length === 6 && vendor) {
      const prefix = `${hex.slice(0,2)}:${hex.slice(2,4)}:${hex.slice(4,6)}`.toUpperCase();
      map.set(prefix, vendor);
    }
  }
  return map;
}

function fetchOuiDatabase() {
  if (_fetchInProgress) return;
  _fetchInProgress = true;

  log('info', 'OUI: baixando base IEEE...');
  const req = https.get(IEEE_OUI_URL, { timeout: 30000 }, (res) => {
    if (res.statusCode !== 200) {
      log('warn', 'OUI: download falhou', { status: res.statusCode });
      _fetchInProgress = false;
      return;
    }
    const chunks = [];
    res.on('data', c => chunks.push(c));
    res.on('end', () => {
      try {
        const csv = Buffer.concat(chunks).toString('utf8');
        const map = parseOuiCsv(csv);
        if (map.size > 1000) {
          // Merge com builtin (builtin tem prioridade para correções locais)
          for (const [k, v] of Object.entries(BUILTIN_OUI)) map.set(k, v);
          _ouiMap = map;
          _lastFetch = Date.now();
          const cache = { ts: _lastFetch, entries: Object.fromEntries(map) };
          fs.writeFile(CACHE_PATH, JSON.stringify(cache), () => {});
          log('info', 'OUI: base atualizada', { entries: map.size });
        }
      } catch (e) {
        log('warn', 'OUI: parse falhou', { err: e.message });
      }
      _fetchInProgress = false;
    });
    res.on('error', () => { _fetchInProgress = false; });
  });
  req.on('error', (e) => {
    log('warn', 'OUI: erro de rede', { err: e.message });
    _fetchInProgress = false;
  });
  req.on('timeout', () => { req.destroy(); _fetchInProgress = false; });
}

// Tenta carregar cache em disco na inicialização
try {
  if (fs.existsSync(CACHE_PATH)) {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (raw.ts && raw.entries && Object.keys(raw.entries).length > 1000) {
      _ouiMap = new Map(Object.entries(raw.entries));
      _lastFetch = raw.ts;
      log('info', 'OUI: cache carregado do disco', { entries: _ouiMap.size });
    }
  }
} catch (_) {}

// Atualização periódica (sem bloquear startup)
function scheduleRefresh() {
  const age = Date.now() - _lastFetch;
  if (age > REFRESH_MS) {
    setImmediate(fetchOuiDatabase);
  }
  // Verifica todo dia
  setInterval(() => {
    if (Date.now() - _lastFetch > REFRESH_MS) fetchOuiDatabase();
  }, 24 * 60 * 60 * 1000).unref();
}

scheduleRefresh();

/**
 * Retorna o fabricante pelo prefixo MAC (primeiros 3 octetos).
 * @param {string} mac - ex: "a5:08:91:04:a3:97"
 * @returns {string|null}
 */
function lookupMacVendor(mac) {
  if (!mac) return null;
  const prefix = normPrefix(mac);
  return _ouiMap.get(prefix) || null;
}

/** Força atualização imediata da base OUI (para testes/admin). */
function forceRefresh() {
  _lastFetch = 0;
  fetchOuiDatabase();
}

module.exports = { lookupMacVendor, forceRefresh };
