'use strict';

/**
 * R-Observe AIOps — Root Cause Analysis Engine
 *
 * Analisa incidentes para determinar causas-raiz prováveis usando:
 *   1. Análise de grafo de dependências (topologia)
 *   2. Correlação temporal de eventos
 *   3. Similaridade com incidentes anteriores
 *   4. Regras heurísticas baseadas em domínio
 *
 * Cada análise produz:
 *   - root_cause_hypothesis: causa provável
 *   - confidence_score: 0.0 a 1.0
 *   - evidence_chain: cadeia de evidências
 *   - impacted_systems: sistemas afetados
 *   - similar_incidents: incidentes similares
 *   - suggested_actions: plano de ação
 */

// ─── Domain Heuristics ───────────────────────────────────────────────────────

const DOMAIN_RULES = [
  // Database → Application
  {
    name: 'database_cascade',
    condition: (incident) => {
      return incident.target_type === 'database' &&
             ['down', 'critical', 'unreachable'].includes(incident.severity);
    },
    analyze: (incident, topology) => {
      const dependents = topology.filter(t =>
        t.dependency_type === 'service_database' &&
        t.target === incident.target_id
      );
      return {
        hypothesis: `Falha no banco de dados ${incident.target_name} causou indisponibilidade em ${dependents.length} serviços dependentes`,
        impacted_systems: dependents.map(d => d.source),
        confidence: dependents.length > 0 ? 0.85 : 0.5,
        type: 'cascade_failure',
      };
    },
  },
  // Network → Everything behind it
  {
    name: 'network_partition',
    condition: (incident) => {
      return ['switch', 'router', 'firewall', 'network_device'].includes(incident.target_type) &&
             ['down', 'unreachable'].includes(incident.severity);
    },
    analyze: (incident, topology) => {
      const behind = topology.filter(t =>
        t.path && t.path.includes(incident.target_id)
      );
      return {
        hypothesis: `Falha no dispositivo de rede ${incident.target_name} afeta ${behind.length} sistemas downstream`,
        impacted_systems: behind.map(b => b.target),
        confidence: behind.length > 0 ? 0.9 : 0.4,
        type: 'network_partition',
      };
    },
  },
  // Docker host → containers
  {
    name: 'docker_host_failure',
    condition: (incident) => {
      return incident.source === 'docker' && incident.severity === 'critical';
    },
    analyze: (incident) => {
      return {
        hypothesis: `Falha no host Docker ${incident.target_name} — containers e serviços hospedados podem estar indisponíveis`,
        impacted_systems: [],
        confidence: 0.8,
        type: 'container_host_failure',
      };
    },
  },
  // Disk full
  {
    name: 'disk_full_cascade',
    condition: (incident) => {
      return incident.check_type === 'disk' &&
             ['critical', 'warning'].includes(incident.severity);
    },
    analyze: (incident) => {
      return {
        hypothesis: `Disco cheio/chegando no limite em ${incident.target_name} — pode causar falhas em serviços que escrevem no disco (bancos de dados, logs, filas)`,
        impacted_systems: [],
        confidence: 0.75,
        type: 'resource_exhaustion',
        suggested_actions: [
          'Verificar uso de disco com df -h',
          'Limpar logs antigos e arquivos temporários',
          'Expandir volume de disco se necessário',
        ],
      };
    },
  },
  // High CPU
  {
    name: 'high_cpu',
    condition: (incident) => {
      return incident.check_type === 'load' &&
             incident.severity === 'critical';
    },
    analyze: (incident) => {
      return {
        hypothesis: `Carga de CPU crítica em ${incident.target_name} — pode degradar todos os serviços no host`,
        impacted_systems: [],
        confidence: 0.7,
        type: 'resource_exhaustion',
        suggested_actions: [
          'Identificar processo com maior consumo: top ou htop',
          'Verificar se há processos zumbis ou runaway',
          'Considerar escalar horizontalmente se for recorrente',
        ],
      };
    },
  },
  // Memory exhaustion
  {
    name: 'memory_exhaustion',
    condition: (incident) => {
      return incident.check_type === 'memory' &&
             incident.severity === 'critical';
    },
    analyze: (incident) => {
      return {
        hypothesis: `Exaustão de memória em ${incident.target_name} — OOM Killer pode derrubar processos críticos`,
        impacted_systems: [],
        confidence: 0.75,
        type: 'resource_exhaustion',
        suggested_actions: [
          'Verificar processos com maior consumo de RAM: ps aux --sort=-%mem',
          'Verificar memory leaks em aplicações',
          'Aumentar RAM ou adicionar swap se possível',
        ],
      };
    },
  },
  // Certificate expiry
  {
    name: 'certificate_expiry',
    condition: (incident) => {
      return incident.check_type === 'ssl_cert' &&
             ['warning', 'critical'].includes(incident.severity);
    },
    analyze: (incident) => {
      const days = incident.metadata?.days_remaining || 0;
      const urgency = days <= 7 ? 'IMEDIATA' : days <= 30 ? 'urgente' : 'planejada';
      return {
        hypothesis: `Certificado SSL de ${incident.target_name} expira em ${days} dias — renovação ${urgency} necessária`,
        impacted_systems: [incident.target_id],
        confidence: 0.95,
        type: 'certificate_expiry',
        suggested_actions: [
          'Renovar certificado SSL/TLS',
          'Configurar auto-renew com Let\'s Encrypt ou ACME',
          'Verificar todos os certificados da organização',
        ],
      };
    },
  },
];

// ─── Temporal Correlator ─────────────────────────────────────────────────────

/**
 * Busca eventos correlacionados no tempo.
 * Eventos que ocorrem em janela de tempo próxima têm mais chance de relação causal.
 */
function correlateTemporal(incident, recentEvents, windowMs = 300000) {
  const incidentTime = new Date(incident.timestamp || incident.created_at).getTime();
  const correlated = [];

  for (const event of recentEvents) {
    const eventTime = new Date(event.timestamp || event.created_at).getTime();
    const delta = Math.abs(eventTime - incidentTime);

    if (delta <= windowMs && event.id !== incident.id) {
      // Eventos muito próximos (< 30s) têm alta correlação temporal
      const temporalScore = delta <= 30000 ? 0.9 :
                            delta <= 60000 ? 0.7 :
                            delta <= 120000 ? 0.5 :
                            delta <= 300000 ? 0.3 : 0.1;

      correlated.push({
        event_id: event.id,
        event_title: event.title,
        event_type: event.type || event.check_type,
        target: event.target_name || event.host_name,
        delta_ms: delta,
        temporal_score: temporalScore,
        direction: eventTime < incidentTime ? 'before' : 'after',
      });
    }
  }

  return correlated.sort((a, b) => b.temporal_score - a.temporal_score);
}

// ─── Topology-Based Root Cause ───────────────────────────────────────────────

/**
 * Se um nó upstream falha, todos os downstreams são potencialmente afetados.
 */
function findUpstreamRootCause(incident, topology) {
  const upstream = topology.filter(t =>
    t.target === incident.target_id &&
    t.dependency_type
  );

  if (upstream.length === 0) return null;

  const sources = upstream.map(u => u.source);
  return {
    hypothesis: `${incident.target_name} depende de: ${sources.join(', ')}. Verificar se a causa é upstream.`,
    upstream_dependencies: sources,
    confidence: 0.6,
    type: 'upstream_dependency',
  };
}

// ─── Main RCA Engine ─────────────────────────────────────────────────────────

/**
 * @param {object} incident
 *   - id, title, severity, status, source
 *   - target_id, target_name, target_type
 *   - check_type, host_name
 *   - timestamp / created_at
 *   - metadata
 * @param {object} context
 *   - topology: array de { source, target, dependency_type, path }
 *   - recent_events: array de eventos recentes
 *   - similar_incidents: array de incidentes similares (do incident-memory)
 * @returns {object}
 */
function analyzeRootCause(incident, context = {}) {
  const topology = context.topology || [];
  const recentEvents = context.recent_events || [];
  const similarIncidents = context.similar_incidents || [];

  const results = [];

  // 1. Apply domain heuristics
  for (const rule of DOMAIN_RULES) {
    try {
      if (rule.condition(incident)) {
        const analysis = rule.analyze(incident, topology);
        results.push({
          rule: rule.name,
          ...analysis,
          source: 'domain_heuristic',
        });
      }
    } catch (_) { /* rule failure is non-fatal */ }
  }

  // 2. Upstream dependency analysis
  const upstreamRCA = findUpstreamRootCause(incident, topology);
  if (upstreamRCA) {
    results.push({ ...upstreamRCA, source: 'topology_analysis' });
  }

  // 3. Temporal correlation
  const temporalCorrelations = correlateTemporal(incident, recentEvents);
  if (temporalCorrelations.length > 0) {
    const highCorr = temporalCorrelations.filter(c => c.temporal_score >= 0.7);
    if (highCorr.length > 0) {
      results.push({
        hypothesis: `${highCorr.length} evento(s) com alta correlação temporal (${Math.round(highCorr[0].delta_ms / 1000)}s): ${highCorr.map(c => c.event_title).join(', ')}`,
        correlated_events: highCorr,
        confidence: 0.65,
        type: 'temporal_correlation',
        source: 'temporal_analysis',
      });
    }
  }

  // 4. Similar incident analysis
  if (similarIncidents.length > 0) {
    const bestMatch = similarIncidents[0];
    results.push({
      hypothesis: `Incidente similar a "${bestMatch.title}" (${Math.round(bestMatch.similarity * 100)}% similar) — mesma causa provável: ${bestMatch.resolved_cause || 'não documentada'}`,
      similar_incident_id: bestMatch.id,
      similarity_score: bestMatch.similarity,
      confidence: bestMatch.similarity * 0.8,
      type: 'similar_incident',
      source: 'incident_memory',
    });
  }

  // Sort by confidence desc
  results.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  // Build final analysis
  const bestRCA = results[0] || null;

  return {
    incident_id: incident.id,
    analyzed_at: new Date().toISOString(),
    root_cause_hypotheses: results.slice(0, 5),
    best_hypothesis: bestRCA ? {
      cause: bestRCA.hypothesis,
      confidence: bestRCA.confidence,
      type: bestRCA.type,
      source: bestRCA.source,
    } : null,
    impacted_systems: [...new Set(results.flatMap(r => r.impacted_systems || []))],
    evidence_chain: results.map(r => ({
      type: r.type,
      source: r.source,
      confidence: r.confidence,
    })),
    suggested_actions: results.flatMap(r => r.suggested_actions || []),
    temporal_correlations: temporalCorrelations.slice(0, 10),
    confidence_breakdown: {
      domain_heuristics: results.filter(r => r.source === 'domain_heuristic').length,
      topology_analysis: results.filter(r => r.source === 'topology_analysis').length,
      temporal_analysis: results.filter(r => r.source === 'temporal_analysis').length,
      incident_memory: results.filter(r => r.source === 'incident_memory').length,
    },
  };
}

module.exports = {
  analyzeRootCause,
  correlateTemporal,
  DOMAIN_RULES,
};
