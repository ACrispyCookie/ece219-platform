import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import type { ProxyOptions } from 'vite';

const apiProxy: ProxyOptions = {
  target: 'http://127.0.0.1:3460',
  changeOrigin: true,
  configure(proxy) {
    proxy.on('proxyReq', (outgoing, incoming) => {
      // Translate only this browser's exact dev origin; missing/hostile origins
      // must reach the API unchanged for its cookie-mutation Origin guard.
      if (incoming.headers.origin === `http://${incoming.headers.host}`) {
        outgoing.setHeader('Origin', `http://${outgoing.getHeader('host')}`);
      }
    });
  },
};
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    proxy: {
      '/api': apiProxy,
      '/docs': apiProxy,
      '/openapi.json': apiProxy,
    },
  },
  test: { environment: 'jsdom', setupFiles: ['./src/test/setup.ts'], restoreMocks: true },
});
