import { defineConfig } from 'vite';
import { adminCredentialHeaderName } from './src/auth';

const apiTarget = process.env.SHEETFLARE_API_BASE_URL?.trim() || 'http://127.0.0.1:8787';

export default defineConfig({
  server: {
    proxy: {
      '/v1': {
        target: apiTarget,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            const credential = request.headers[adminCredentialHeaderName];
            if (typeof credential !== 'string' || credential.length === 0) {
              return;
            }

            proxyRequest.setHeader('authorization', `Bearer ${credential}`);
            proxyRequest.removeHeader(adminCredentialHeaderName);
          });
        }
      },
      '/health': apiTarget,
      '/ready': apiTarget,
      '/doc': apiTarget,
      '/docs': apiTarget
    }
  }
});
