'use strict';

// ─── R-Observe: Auto-instrumentação OpenTelemetry ─────────────────────────────
// Carregado via --require antes do app principal.
// Configurado inteiramente por variáveis de ambiente:
//   OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_TRACES_SAMPLER, etc.

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // Sem endpoint configurado — não ativa o SDK
  return;
}

const { NodeSDK }                     = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

const sdk = new NodeSDK({
  // Resource, exporters e sampler lidos das env vars OTEL_* automaticamente
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        // Não rastreia health checks para não poluir
        ignoreIncomingRequestHook: (req) =>
          req.url === '/health' || req.url === '/metrics' ||
          req.url?.startsWith('/observe/api/health'),
        ignoreOutgoingRequestHook: (opts) =>
          String(opts.path || opts.pathname || '').includes('/health'),
      },
      '@opentelemetry/instrumentation-pg': {
        enabled: true,
        enhancedDatabaseReporting: false,
      },
      '@opentelemetry/instrumentation-ioredis': { enabled: true },
      '@opentelemetry/instrumentation-dns':     { enabled: false },
      '@opentelemetry/instrumentation-net':     { enabled: false },
      '@opentelemetry/instrumentation-fs':      { enabled: false },
    }),
  ],
});

sdk.start();

process.stdout.write(JSON.stringify({
  level:    'info',
  service:  process.env.OTEL_SERVICE_NAME || 'unknown',
  msg:      'OTel SDK iniciado',
  endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  ts:       new Date().toISOString(),
}) + '\n');

process.on('SIGTERM', async () => {
  try { await sdk.shutdown(); } catch { /* silencia */ }
});
