'use strict';

/**
 * R-Observe AIOps — Incident Memory
 *
 * Armazena e recupera incidentes históricos para:
 *   1. Busca de incidentes similares
 *   2. Aprendizado com resoluções anteriores
 *   3. Sugestão de ações baseadas em histórico
 *   4. Timeline de incidentes
 *
 * Similaridade calculada por:
 *   - Tipo de incidente (check_type, source)
 *   - Host/target
 *   - Severidade
 *   - Palavras-chave no título/descrição
 */

// ─── Similarity Engine ───────────────────────────────────────────────────────

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function jaccardSimilarity(setA, setB) {
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function cosineSimilarity(vecA, vecB) {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  const allKeys = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);

  for (const key of allKeys) {
    const a = vecA[key] || 0;
    const b = vecB[key] || 0;
    dotProduct += a * b;
    normA += a * a;
    normB += b * b;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function tfVector(tokens) {
  const vec = {};
  for (const t of tokens) {
    vec[t] = (vec[t] || 0) + 1;
  }
  return vec;
}

/**
 * Calcula similaridade entre dois incidentes (0-1).
 */
function calculateSimilarity(incidentA, incidentB) {
  const scores = [];

  // 1. Exata correspondência de tipo (check_type)
  if (incidentA.check_type && incidentA.check_type === incidentB.check_type) {
    scores.push({ weight: 0.3, value: 1.0 });
  } else if (incidentA.check_type && incidentB.check_type) {
    scores.push({ weight: 0.3, value: 0.0 });
  }

  // 2. Mesmo host
  if (incidentA.host_name && incidentA.host_name === incidentB.host_name) {
    scores.push({ weight: 0.2, value: 1.0 });
  }

  // 3. Mesmo target_type
  if (incidentA.target_type && incidentA.target_type === incidentB.target_type) {
    scores.push({ weight: 0.15, value: 1.0 });
  } else if (incidentA.target_type && incidentB.target_type) {
    scores.push({ weight: 0.15, value: 0.0 });
  }

  // 4. Mesma severidade
  if (incidentA.severity && incidentA.severity === incidentB.severity) {
    scores.push({ weight: 0.1, value: 1.0 });
  } else if (incidentA.severity && incidentB.severity) {
    // Severidade similar (info/warning próximos, critical/down próximos)
    const severities = { ok: 0, info: 1, warning: 2, critical: 3, down: 3 };
    const diff = Math.abs((severities[incidentA.severity] || 0) - (severities[incidentB.severity] || 0));
    scores.push({ weight: 0.1, value: Math.max(0, 1 - diff / 3) });
  }

  // 5. Similaridade textual (título + descrição)
  const textA = [incidentA.title, incidentA.description, incidentA.ai_summary].filter(Boolean).join(' ');
  const textB = [incidentB.title, incidentB.description, incidentB.ai_summary].filter(Boolean).join(' ');

  if (textA && textB) {
    const tokensA = tokenize(textA);
    const tokensB = tokenize(textB);
    const jaccard = jaccardSimilarity(new Set(tokensA), new Set(tokensB));
    const cosineText = cosineSimilarity(tfVector(tokensA), tfVector(tokensB));
    const textSimilarity = (jaccard + cosineText) / 2;
    scores.push({ weight: 0.25, value: textSimilarity });
  }

  // Calculate weighted average
  let totalWeight = 0;
  let weightedSum = 0;
  for (const s of scores) {
    totalWeight += s.weight;
    weightedSum += s.weight * s.value;
  }

  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Busca incidentes similares em um repositório.
 * @param {object} incident - Incidente de referência
 * @param {object[]} repository - Array de incidentes históricos
 * @param {object} options
 *   - minSimilarity: threshold mínimo (default 0.3)
 *   - maxResults: máximo de resultados (default 10)
 * @returns {object[]} incidentes similares ordenados por similaridade
 */
function findSimilarIncidents(incident, repository = [], options = {}) {
  const minSimilarity = options.minSimilarity || 0.3;
  const maxResults = options.maxResults || 10;

  const results = [];

  for (const historical of repository) {
    if (historical.id === incident.id) continue;

    const similarity = calculateSimilarity(incident, historical);

    if (similarity >= minSimilarity) {
      results.push({
        ...historical,
        similarity,
        match_reasons: getMatchReasons(incident, historical),
      });
    }
  }

  return results
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, maxResults);
}

function getMatchReasons(incidentA, incidentB) {
  const reasons = [];

  if (incidentA.check_type && incidentA.check_type === incidentB.check_type) {
    reasons.push(`Mesmo tipo: ${incidentA.check_type}`);
  }
  if (incidentA.host_name && incidentA.host_name === incidentB.host_name) {
    reasons.push(`Mesmo host: ${incidentA.host_name}`);
  }
  if (incidentA.target_type && incidentA.target_type === incidentB.target_type) {
    reasons.push(`Mesmo target: ${incidentA.target_type}`);
  }
  if (incidentA.severity && incidentA.severity === incidentB.severity) {
    reasons.push(`Mesma severidade: ${incidentA.severity}`);
  }

  return reasons;
}

// ─── Incident Store Interface ────────────────────────────────────────────────

/**
 * Interface para armazenamento de incidentes.
 * Implementações: PostgreSQL, in-memory, Redis.
 */
class IncidentStore {
  constructor(options = {}) {
    this.maxSize = options.maxSize || 10000;
    this.incidents = new Map();
  }

  add(incident) {
    const enriched = {
      ...incident,
      _indexed_at: new Date().toISOString(),
      _tokens: tokenize([incident.title, incident.description, incident.ai_summary]
        .filter(Boolean).join(' ')),
    };

    this.incidents.set(incident.id, enriched);

    // Evict oldest if over max size
    if (this.incidents.size > this.maxSize) {
      const oldest = [...this.incidents.entries()]
        .sort((a, b) => new Date(a[1]._indexed_at) - new Date(b[1]._indexed_at))[0];
      if (oldest) this.incidents.delete(oldest[0]);
    }
  }

  get(id) {
    return this.incidents.get(id) || null;
  }

  search(incident, options = {}) {
    const all = [...this.incidents.values()];
    return findSimilarIncidents(incident, all, options);
  }

  getAll() {
    return [...this.incidents.values()]
      .sort((a, b) => new Date(b.created_at || b._indexed_at) - new Date(a.created_at || a._indexed_at));
  }

  getByHost(hostName) {
    return this.getAll().filter(i =>
      i.host_name === hostName || i.target_name === hostName
    );
  }

  getStats() {
    const all = this.getAll();
    const bySeverity = {};
    const byType = {};
    const byStatus = {};

    for (const i of all) {
      bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
      byType[i.check_type || i.type || 'unknown'] = (byType[i.check_type || i.type || 'unknown'] || 0) + 1;
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    }

    return {
      total: all.length,
      by_severity: bySeverity,
      by_type: byType,
      by_status: byStatus,
      oldest_incident: all[all.length - 1]?._indexed_at || null,
      newest_incident: all[0]?._indexed_at || null,
    };
  }
}

module.exports = {
  IncidentStore,
  findSimilarIncidents,
  calculateSimilarity,
  correlationScore: calculateSimilarity, // alias
};
