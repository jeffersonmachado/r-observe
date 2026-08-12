'use strict';

/**
 * Metricas Prometheus para o Discovery.
 * Centraliza todos os counters, gauges e histograms.
 */
const client = require('prom-client');

const metrics = {
  // ── Scan ──
  scanDuration: new client.Histogram({
    name: 'discovery_scan_duration_seconds',
    help: 'Duracao total do scan (policy → done)',
    buckets: [30, 60, 120, 300, 600, 1800, 3600],
    labelNames: ['profile'],
  }),
  scanTargetsTotal: new client.Gauge({
    name: 'discovery_scan_targets_total',
    help: 'Numero de targets no ultimo scan',
  }),
  scanDiscoveredTotal: new client.Gauge({
    name: 'discovery_scan_discovered_total',
    help: 'Ativos descobertos no ultimo scan',
  }),
  scanTopologyEdges: new client.Gauge({
    name: 'discovery_scan_topology_edges',
    help: 'Arestas de topologia no ultimo scan',
  }),

  // ── Falhas ──
  scanFailures: new client.Counter({
    name: 'discovery_scan_failures_total',
    help: 'Total de scans que falharam',
    labelNames: ['reason'],
  }),
  targetFailures: new client.Counter({
    name: 'discovery_target_failures_total',
    help: 'Total de targets que falharam sem abortar a execucao',
    labelNames: ['source'],
  }),
  retentionDeleted: new client.Counter({
    name: 'discovery_retention_deleted_total',
    help: 'Registros removidos pela politica de retencao',
    labelNames: ['table'],
  }),
  passiveRejected: new client.Counter({
    name: 'discovery_passive_rejected_total',
    help: 'Eventos passivos rejeitados por controles operacionais',
    labelNames: ['reason'],
  }),
  queueDepth: new client.Gauge({
    name: 'discovery_scan_queue_depth',
    help: 'Quantidade atual de scans aguardando na fila Redis',
  }),
  queueProcessing: new client.Gauge({
    name: 'discovery_scan_queue_processing',
    help: 'Quantidade atual de scans reclamados por consumidores',
  }),
  queueDeadLetter: new client.Gauge({
    name: 'discovery_scan_queue_dead_letter',
    help: 'Quantidade de scans na dead-letter queue',
  }),
  queueConsumers: new client.Gauge({
    name: 'discovery_scan_queue_consumers',
    help: 'Consumidores de scan com heartbeat ativo',
  }),
  expansionExceeded: new client.Counter({
    name: 'discovery_expansion_exceeded_total',
    help: 'Vezes que a expansao de targets excedeu o limite',
  }),

  // ── Icinga Sync ──
  icingaSyncTotal: new client.Counter({
    name: 'discovery_icinga_sync_total',
    help: 'Total de syncs com Icinga2',
    labelNames: ['status'], // success, skipped, error
  }),
  icingaHostsSynced: new client.Gauge({
    name: 'discovery_icinga_hosts_synced',
    help: 'Hosts sincronizados no ultimo sync Icinga2',
  }),
  icingaServicesSynced: new client.Gauge({
    name: 'discovery_icinga_services_synced',
    help: 'Servicos sincronizados no ultimo sync Icinga2',
  }),

  // ── Validators ──
  validatorBlocks: new client.Counter({
    name: 'discovery_validator_blocks_total',
    help: 'Vezes que validadores bloquearam operacao',
    labelNames: ['validator'],
  }),

  // ── Assets ──
  assetsGauge: new client.Gauge({
    name: 'discovery_assets_gauge',
    help: 'Total de ativos no inventario ativo',
  }),
  servicesGauge: new client.Gauge({
    name: 'discovery_services_gauge',
    help: 'Total de servicos detectados',
  }),

  // ── Worker / Pipeline ──
  pipelineStageDuration: new client.Histogram({
    name: 'discovery_pipeline_stage_duration_seconds',
    help: 'Duracao de cada estagio do pipeline',
    buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 300],
    labelNames: ['stage'],
  }),
};

module.exports = metrics;
