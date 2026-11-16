import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';
import { isIPv6 } from 'node:net';

// The browser export uses document.createElement; a Web Worker needs the pure decoder.
const workerDecoder = createRequire(import.meta.url).resolve('decode-named-character-reference');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const apiPort = env.PORT || '3001';
  const host = env.HOST === '::' ? '::1' : env.HOST;
  const apiHost = host === '0.0.0.0' ? '127.0.0.1' : host || '127.0.0.1';
  const apiAuthority = isIPv6(apiHost) ? `[${apiHost}]` : apiHost;
  return {
    plugins: [react()],
    // An alias also covers Vite's dependency optimizer during development.
    resolve: { alias: { 'decode-named-character-reference': workerDecoder } },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://${apiAuthority}:${apiPort}` } },
    },
  };
});
