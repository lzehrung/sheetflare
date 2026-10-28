import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Connect, type Plugin, type ProxyOptions } from 'vite';
import {
  adminHost,
  adminPort,
  adminResponseHeaders,
  handleAdminSessionRequest,
  resolveAdminApiTarget,
  resolveServerAdminCredential,
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

const serverCredential = resolveServerAdminCredential(process.env);
console.log(
  serverCredential === null
    ? '[sheetflare-admin] no server-side admin credential; enter one in the UI'
    : '[sheetflare-admin] using server-side admin credential from the environment'
);

function createApiProxyOptions(): ProxyOptions {
  return {
    target: apiTarget,
    changeOrigin: true,
    configure(proxy) {
      proxy.on('proxyReq', (proxyRequest, request) => {
        rewriteAdminProxyRequest(proxyRequest, request, serverCredential);
      });
      proxy.on('proxyRes', rewriteAdminProxyResponse);
    }
  };
}

const adminSessionMiddleware: Connect.NextHandleFunction = (request, response, next) => {
  if (!handleAdminSessionRequest(request, response, serverCredential !== null)) {
    next();
  }
};

const adminSessionPlugin: Plugin = {
  name: 'sheetflare-admin-session',
  configureServer(server) {
    server.middlewares.use(adminSessionMiddleware);
  },
  configurePreviewServer(server) {
    server.middlewares.use(adminSessionMiddleware);
  }
};

export default defineConfig({
  plugins: [adminSessionPlugin],
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
