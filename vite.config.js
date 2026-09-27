import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 8192,
    assetsInlineLimit: 0,
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    host: '127.0.0.1',
  },
});
