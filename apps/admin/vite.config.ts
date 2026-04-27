import { defineConfig } from 'vite';

const apiTarget = process.env.SHEETFLARE_API_BASE_URL?.trim() || 'http://127.0.0.1:8787';

export default defineConfig({
  server: {
    proxy: {
      '/v1': apiTarget,
      '/health': apiTarget,
      '/ready': apiTarget,
      '/doc': apiTarget,
      '/docs': apiTarget
    }
  }
});
