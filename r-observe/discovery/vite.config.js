import { defineConfig } from 'vite';
import net from 'node:net';

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '0.0.0.0');
  });
}

async function findHmrPort() {
  const start = Number.parseInt(process.env.DISCOVERY_VITE_HMR_PORT || '24680', 10);
  for (let port = start; port < start + 40; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free Discovery Vite HMR port found from ${start} to ${start + 39}`);
}

export default defineConfig(async () => ({
  // root = r-observe/discovery/ (onde este arquivo está)
  server: {
    middlewareMode: true,
    hmr: {
      port: await findHmrPort(),
    },
    watch: {
      usePolling: true,
      ignored: ['**/node_modules/**', '**/.git/**'],
    },
  },
  appType: 'custom',
}));
