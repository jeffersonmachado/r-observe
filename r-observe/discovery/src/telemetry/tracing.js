'use strict';

if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  return;
}

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');

const sdk = new NodeSDK({
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-http': {
        enabled: true,
        ignoreIncomingRequestHook: (req) => req.url === '/health' || req.url === '/metrics',
      },
      '@opentelemetry/instrumentation-pg': { enabled: true, enhancedDatabaseReporting: false },
      '@opentelemetry/instrumentation-ioredis': { enabled: true },
    }),
  ],
});

sdk.start();

process.on('SIGTERM', async () => {
  try {
    await sdk.shutdown();
  } catch {
    // noop
  }
});
