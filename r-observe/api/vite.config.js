import { defineConfig } from 'vite';

export default defineConfig({
  // root = r-observe/api/ (onde este arquivo está)
  appType: 'custom',
  server: {
    watch: {
      usePolling: true,
      ignored: ['**/node_modules/**', '**/.git/**'],
    },
  },
});
