'use strict';

/**
 * Knowledge Base Loader — carrega arquivos YAML/JSON do diretório knowledge/
 * com hot-reload (watch via fs.watch).
 *
 * Estrutura:
 *   knowledge/
 *     port-hints.yml       → mapeamento porta→tecnologia
 *     services.yml         → mapeamento serviços→dependências/exporters
 *     inference-registry.json → text_patterns, rules, thresholds (legado, carregado como está)
 *
 * Uso:
 *   const kb = require('./loader');
 *   kb.getPortHint(8009) → { technology: 'java', category: 'application', ... }
 *   kb.getServiceForPort(5432) → { name: 'PostgreSQL', dependency_type: 'service_database', ... }
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { log, debug, info, warn } = require('../utils/logger');

const KNOWLEDGE_DIR = process.env.DISCOVERY_KNOWLEDGE_DIR || path.join(__dirname, '..', '..', 'knowledge');
const HOT_RELOAD_ENABLED = process.env.DISCOVERY_KNOWLEDGE_HOT_RELOAD !== 'false';

// ── Cache ────────────────────────────────────────────────────────────────────

let _cache = {
  portHints: {},
  services: [],
  osDefaults: {},
  osPatterns: [],  // mapeamento tecnologia→chave em osDefaults
  inferenceRegistry: { port_hints: {}, text_patterns: [], thresholds: {}, rules: [] },
};

// ── Loaders ──────────────────────────────────────────────────────────────────

function loadYamlFile(filename) {
  const filePath = path.join(KNOWLEDGE_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      warn(`Knowledge file not found: ${filePath}`);
      return null;
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content);
  } catch (e) {
    warn(`Failed to load knowledge file: ${filename}`, { error: e.message });
    return null;
  }
}

function loadJsonFile(filename) {
  const filePath = path.join(KNOWLEDGE_DIR, filename);
  try {
    if (!fs.existsSync(filePath)) {
      // Try legacy path: src/inference/registry/
      const legacyPath = path.join(__dirname, '..', 'inference', 'registry', filename);
      if (fs.existsSync(legacyPath)) {
        return JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      }
      warn(`Knowledge file not found: ${filePath}`);
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    warn(`Failed to load knowledge file: ${filename}`, { error: e.message });
    return null;
  }
}

function loadAll() {
  // Port hints
  const portHintsYaml = loadYamlFile('port-hints.yml');
  if (portHintsYaml?.ports) {
    _cache.portHints = portHintsYaml.ports;
    info(`Knowledge: port-hints loaded (${Object.keys(_cache.portHints).length} ports)`);
  }

  // Services
  const servicesYaml = loadYamlFile('services.yml');
  if (servicesYaml?.services) {
    _cache.services = servicesYaml.services;
    info(`Knowledge: services loaded (${_cache.services.length} services)`);
  }

  // Inference registry (JSON — mantém formato original para compatibilidade)
  const registry = loadJsonFile('inference-registry.json');
  if (registry) {
    _cache.inferenceRegistry = registry;
    info(`Knowledge: inference-registry loaded (${(registry.rules || []).length} rules, ${(registry.text_patterns || []).length} patterns)`);
  }

  // Merge port hints do YAML com os do JSON (YAML tem precedência)
  const jsonHints = _cache.inferenceRegistry.port_hints || {};
  _cache.inferenceRegistry.port_hints = { ...jsonHints, ..._cache.portHints };

  // OS defaults
  const osDefaultsYaml = loadYamlFile('os-defaults.yml');
  if (osDefaultsYaml?.defaults) {
    _cache.osDefaults = osDefaultsYaml.defaults;
    _cache.osPatterns = [];
    const techMap = {
      linux: ['linux', 'ubuntu', 'debian', 'rhel', 'centos', 'fedora', 'alpine', 'arch', 'suse', 'gentoo', 'kali', 'oracle-linux', 'rocky', 'almalinux'],
      windows: ['windows', 'win32', 'win64'],
      darwin: ['darwin', 'macos', 'osx', 'mac'],
      freebsd: ['freebsd', 'openbsd', 'netbsd', 'dragonfly'],
      network_device: ['network_device', 'switch', 'router', 'firewall'],
      vmware: ['vmware', 'esx', 'esxi'],
    };
    for (const [key, aliases] of Object.entries(techMap)) {
      for (const alias of aliases) {
        _cache.osPatterns.push({ alias, key });
      }
    }
    info(`Knowledge: os-defaults loaded (${Object.keys(_cache.osDefaults).length} OS profiles)`);
  }

  debug('Knowledge base reloaded', {
    port_hints: Object.keys(_cache.inferenceRegistry.port_hints).length,
    services: _cache.services.length,
    os_profiles: Object.keys(_cache.osDefaults).length,
    rules: (_cache.inferenceRegistry.rules || []).length,
    patterns: (_cache.inferenceRegistry.text_patterns || []).length,
  });
}

// ── Hot-reload ───────────────────────────────────────────────────────────────

let _watcher = null;

function startWatcher() {
  if (_watcher || !HOT_RELOAD_ENABLED) return;

  try {
    _watcher = fs.watch(KNOWLEDGE_DIR, { persistent: false }, (eventType, filename) => {
      if (!filename || !/\.(yml|yaml|json)$/i.test(filename)) return;
      info(`Knowledge file changed: ${filename}, reloading...`);
      setTimeout(loadAll, 200); // debounce
    });
    _watcher.unref();
    info(`Knowledge hot-reload watching: ${KNOWLEDGE_DIR}`);
  } catch (e) {
    warn('Knowledge hot-reload not available', { error: e.message });
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

function getPortHints() {
  return _cache.inferenceRegistry.port_hints || {};
}

function getPortHint(port) {
  return _cache.inferenceRegistry.port_hints?.[port] || null;
}

function getServices() {
  return _cache.services || [];
}

function getServiceForPort(port) {
  return _cache.services.find(s => (s.ports || []).includes(port)) || null;
}

function getInferenceRegistry() {
  return _cache.inferenceRegistry;
}

function getTextPatterns() {
  return (_cache.inferenceRegistry.text_patterns || []).map(p => ({
    ...p,
    re: new RegExp(p.pattern, p.flags || ''),
  }));
}

function getRules() {
  return _cache.inferenceRegistry.rules || [];
}

function getThresholds() {
  return _cache.inferenceRegistry.thresholds || {};
}

function getOsDefaults(technology) {
  if (!technology) return null;
  const tech = String(technology).toLowerCase();
  // Procura correspondência exata
  if (_cache.osDefaults[tech]) return _cache.osDefaults[tech];
  // Procura por alias
  const match = _cache.osPatterns.find(p => p.alias === tech);
  if (match) return _cache.osDefaults[match.key] || null;
  return null;
}

// ── Init ─────────────────────────────────────────────────────────────────────

loadAll();
startWatcher();

module.exports = {
  getPortHints,
  getPortHint,
  getServices,
  getOsDefaults,
  getServiceForPort,
  getInferenceRegistry,
  getTextPatterns,
  getRules,
  getThresholds,
  reload: loadAll,
};
