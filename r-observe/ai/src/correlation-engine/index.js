'use strict';

/**
 * R-Observe AIOps — Event Correlation Engine
 *
 * Correlaciona eventos para:
 *   1. Deduplicação de alertas
 *   2. Agrupamento (clustering) de eventos relacionados
 *   3. Detecção de padrões (padrões de falha recorrentes)
 *   4. Supressão de alertas redundantes
 */

// ─── Alert Deduplication ─────────────────────────────────────────────────────

/**
 * Deduplica alertas similares em uma janela de tempo.
 * Dois alertas são considerados duplicados se:
 *   - Mesmo host + mesmo check
 *   - Mesma severidade
 *   - Dentro da janela de dedup
 */
function deduplicateAlerts(alerts, windowMs = 300000) {
  const groups = new Map();
  const result = [];

  for (const alert of alerts) {
    const key = `${alert.host_name || alert.target_name}|${alert.check_type || alert.type}|${alert.severity}`;
    const ts = new Date(alert.timestamp || alert.created_at).getTime();

    if (!groups.has(key)) {
      groups.set(key, []);
    }

    const group = groups.get(key);

    // Check if this alert is within window of any alert in the group
    const isDuplicate = group.some(existing => {
      const existingTs = new Date(existing.timestamp || existing.created_at).getTime();
      return Math.abs(ts - existingTs) <= windowMs;
    });

    if (isDuplicate) {
      alert._deduplicated = true;
      alert._original_alert_id = group[0].id;
    }

    group.push(alert);
    result.push(alert);
  }

  return {
    alerts: result,
    dedup_count: result.filter(a => a._deduplicated).length,
    unique_count: result.filter(a => !a._deduplicated).length,
    total: result.length,
  };
}

// ─── Event Clustering ────────────────────────────────────────────────────────

/**
 * Agrupa eventos por similaridade usando:
 *   - host/target comum
 *   - tipo de evento (check_type, source)
 *   - proximidade temporal
 *   - sobreposição de tags
 */
function clusterEvents(events, options = {}) {
  const windowMs = options.windowMs || 600000; // 10 min default
  const clusters = [];

  // Sort by timestamp
  const sorted = [...events].sort((a, b) => {
    const aTs = new Date(a.timestamp || a.created_at).getTime();
    const bTs = new Date(b.timestamp || b.created_at).getTime();
    return aTs - bTs;
  });

  for (const event of sorted) {
    let added = false;
    const eventTs = new Date(event.timestamp || event.created_at).getTime();

    for (const cluster of clusters) {
      // Check if event belongs to this cluster
      const clusterTime = cluster.time_range;
      const withinWindow = eventTs >= clusterTime.start - windowMs &&
                           eventTs <= clusterTime.end + windowMs;

      if (!withinWindow) continue;

      // Check host overlap
      const eventHosts = [event.host_name, event.target_name, event.source_host].filter(Boolean);
      const hostMatch = eventHosts.some(h => cluster.hosts.has(h));

      // Check type similarity
      const eventType = event.check_type || event.type || event.source;
      const typeMatch = eventType && cluster.types.has(eventType);

      if (hostMatch || typeMatch) {
        cluster.events.push(event);
        cluster.hosts.add(...eventHosts);
        cluster.types.add(eventType);
        cluster.time_range.start = Math.min(cluster.time_range.start, eventTs);
        cluster.time_range.end = Math.max(cluster.time_range.end, eventTs);
        added = true;
        break;
      }
    }

    if (!added) {
      const eventHosts = [event.host_name, event.target_name, event.source_host].filter(Boolean);
      const eventType = event.check_type || event.type || event.source;
      clusters.push({
        id: `cluster_${clusters.length + 1}`,
        events: [event],
        hosts: new Set(eventHosts),
        types: new Set(eventType ? [eventType] : []),
        time_range: { start: eventTs, end: eventTs },
        created_at: new Date().toISOString(),
      });
    }
  }

  // Sort clusters by size desc
  clusters.sort((a, b) => b.events.length - a.events.length);

  // Convert Sets to arrays for serialization
  return clusters.map(c => ({
    ...c,
    hosts: [...c.hosts],
    types: [...c.types],
    size: c.events.length,
    time_range_ms: c.time_range.end - c.time_range.start,
    description: `${c.events.length} eventos em ${c.hosts.size} hosts (${[...c.types].join(', ')})`,
  }));
}

// ─── Pattern Detection ───────────────────────────────────────────────────────

/**
 * Detecta padrões de falha recorrentes.
 *
 * Padrões detectados:
 *   - Flapping: alternância up/down repetida
 *   - Escalation: severidade aumentando ao longo do tempo
 *   - Cascade: múltiplos hosts falhando em sequência
 *   - Periodic: falhas em intervalos regulares
 */
function detectPatterns(events, options = {}) {
  const patterns = [];

  // Group events by host
  const byHost = new Map();
  for (const event of events) {
    const host = event.host_name || event.target_name || 'unknown';
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(event);
  }

  for (const [host, hostEvents] of byHost) {
    if (hostEvents.length < 3) continue;

    const sorted = [...hostEvents].sort((a, b) => {
      return new Date(a.timestamp || a.created_at).getTime() -
             new Date(b.timestamp || b.created_at).getTime();
    });

    // Check for flapping (alternating states)
    const states = sorted.map(e => e.status || e.severity);
    let flips = 0;
    for (let i = 1; i < states.length; i++) {
      if (states[i] !== states[i - 1]) flips++;
    }
    if (flips >= 4) {
      patterns.push({
        type: 'flapping',
        host,
        description: `Flapping detectado: ${flips} mudanças de estado em ${sorted.length} eventos`,
        confidence: Math.min(flips / 10, 1),
        events: sorted,
      });
    }

    // Check for escalation
    const severityOrder = { ok: 0, info: 1, warning: 2, critical: 3, down: 3 };
    let escalations = 0;
    for (let i = 1; i < sorted.length; i++) {
      const prev = severityOrder[sorted[i - 1].severity] || 0;
      const curr = severityOrder[sorted[i].severity] || 0;
      if (curr > prev) escalations++;
    }
    if (escalations >= 2) {
      patterns.push({
        type: 'escalation',
        host,
        description: `Escalação detectada: severidade aumentou ${escalations} vezes`,
        confidence: Math.min(escalations / 5, 1),
        events: sorted,
      });
    }

    // Check for periodicity
    if (sorted.length >= 4) {
      const intervals = [];
      for (let i = 1; i < sorted.length; i++) {
        const a = new Date(sorted[i - 1].timestamp || sorted[i - 1].created_at).getTime();
        const b = new Date(sorted[i].timestamp || sorted[i].created_at).getTime();
        intervals.push(b - a);
      }
      const avg = intervals.reduce((s, v) => s + v, 0) / intervals.length;
      const variance = intervals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / intervals.length;
      const stdDev = Math.sqrt(variance);

      // Se o desvio padrão é < 25% da média, é periódico
      if (avg > 60000 && stdDev < avg * 0.25) {
        patterns.push({
          type: 'periodic',
          host,
          description: `Padrão periódico: falhas a cada ~${Math.round(avg / 60000)} minutos`,
          interval_ms: Math.round(avg),
          confidence: 1 - (stdDev / avg),
          events: sorted,
        });
      }
    }
  }

  // Cascade detection: múltiplos hosts falhando em janela curta
  const cascadeGroups = clusterEvents(events, { windowMs: 120000 });
  const cascades = cascadeGroups.filter(c => c.hosts.length >= 3);
  for (const c of cascades) {
    patterns.push({
      type: 'cascade',
      hosts: c.hosts,
      description: `Possível falha em cascata: ${c.hosts.length} hosts em ${Math.round(c.time_range_ms / 1000)}s`,
      confidence: Math.min(c.hosts.length / 10, 0.9),
      cluster_id: c.id,
    });
  }

  return patterns.sort((a, b) => b.confidence - a.confidence);
}

// ─── Correlation Score ───────────────────────────────────────────────────────

/**
 * Calcula score de correlação entre dois eventos.
 * Score 0-1, onde 1 = altamente correlacionados.
 */
function correlationScore(eventA, eventB) {
  let score = 0;
  let factors = 0;

  // Mesmo host
  const hostsA = [eventA.host_name, eventA.target_name].filter(Boolean);
  const hostsB = [eventB.host_name, eventB.target_name].filter(Boolean);
  if (hostsA.some(h => hostsB.includes(h))) {
    score += 0.4;
    factors++;
  }

  // Mesmo tipo
  if ((eventA.check_type || eventA.type) === (eventB.check_type || eventB.type)) {
    score += 0.3;
    factors++;
  }

  // Proximidade temporal
  const tsA = new Date(eventA.timestamp || eventA.created_at).getTime();
  const tsB = new Date(eventB.timestamp || eventB.created_at).getTime();
  const delta = Math.abs(tsA - tsB);
  if (delta <= 30000) { score += 0.3; factors++; }
  else if (delta <= 60000) { score += 0.2; factors++; }
  else if (delta <= 300000) { score += 0.1; factors++; }

  // Mesma severidade
  if (eventA.severity === eventB.severity) {
    score += 0.1;
    factors++;
  }

  return factors > 0 ? score / Math.max(factors, 1) : 0;
}

module.exports = {
  deduplicateAlerts,
  clusterEvents,
  detectPatterns,
  correlationScore,
};
