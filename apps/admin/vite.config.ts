import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';
import {
  adminHost,
  adminPort,
  adminResponseHeaders,
  resolveAdminApiTarget,
  rewriteAdminProxyRequest,
  rewriteAdminProxyResponse
} from './vite-proxy';

const localStatePath = fileURLToPath(new URL('../../.sheetflare.setup.local.json', import.meta.url));

let localStateText: string | null;
try {
  localStateText = readFileSync(localStatePath, 'utf8');
} catch {
  localStateText = null;
}

const apiTarget = resolveAdminApiTarget(process.env.SHEETFLARE_API_BASE_URL, localStateText);
console.log(`[sheetflare-admin] proxying API requests to ${apiTarget}`);

function createApiProxyOptions(): ProxyOptions {
  return {
    target: apiTarget,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', rewriteAdminProxyRequest);
      proxy.on('proxyRes', rewriteAdminProxyResponse);
    }
  };
}

export default defineConfig({
  server: {
    host: adminHost,
    port: adminPort,
    strictPort: true,
    headers: adminResponseHeaders,
    proxy: {
      '/v1': createApiProxyOptions(),
      '/health': createApiProxyOptions(),
      '/ready': createApiProxyOptions(),
      '/doc': createApiProxyOptions(),
      '/docs': createApiProxyOptions()
    }
  },
  preview: {
    host: adminHost,
    port: adminPort,
    strictPort: true,
    headers: adminResponseHeaders
  }
});
