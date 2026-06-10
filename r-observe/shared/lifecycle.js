'use strict';

/**
 * Lifecycle hooks: graceful shutdown e tratamento de erros fatais.
 * Uso:
 *   const lifecycle = createLifecycle({ label: 'r-observe-api', log });
 *   const server = app.listen(...);
 *   lifecycle.onServer(server);
 *   lifecycle.addCloser('db', () => db.close());
 *   lifecycle.addCloser('redis', () => redis.quit());
 *   lifecycle.start();
 */

function createLifecycle({ label, log = console }) {
  const closers = [];
  let server = null;
  let shuttingDown = false;

  function onServer(srv) {
    server = srv;
  }

  function addCloser(name, fn) {
    closers.push({ name, fn });
  }

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log('info', `Recebido ${signal}, desligando...`, { signal });

    // 1. Para de aceitar novas conexões
    if (server) {
      await new Promise((resolve) => {
        server.close(() => {
          log('debug', 'HTTP server closed');
          resolve();
        });
        // Força após timeout
        setTimeout(resolve, 5000);
      });
    }

    // 2. Fecha conexões na ordem inversa
    for (let i = closers.length - 1; i >= 0; i--) {
      const { name, fn } = closers[i];
      try {
        await Promise.race([
          fn(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
        ]);
        log('debug', `Closer "${name}" ok`);
      } catch (e) {
        log('warn', `Closer "${name}" falhou`, { err: e.message });
      }
    }

    log('info', `${label} desligado com sucesso`);
    process.exit(0);
  }

  function start() {
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason) => {
      log('error', 'Unhandled Rejection', {
        err: reason?.message || String(reason),
        stack: reason?.stack?.split('\n').slice(0, 3).join(' | '),
      });
    });

    process.on('uncaughtException', (err) => {
      log('error', 'Uncaught Exception — desligando', {
        err: err.message,
        stack: err.stack?.split('\n').slice(0, 3).join(' | '),
      });
      shutdown('uncaughtException');
    });
  }

  return { onServer, addCloser, start, shutdown };
}

module.exports = { createLifecycle };
