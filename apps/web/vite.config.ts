import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

// The browser export uses document.createElement; a Web Worker needs the pure decoder.
const workerDecoder = createRequire(import.meta.url).resolve('decode-named-character-reference');

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const apiPort = env.PORT || '3001';
  const apiHost = env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST || '127.0.0.1';
  return {
    plugins: [react()],
    // An alias also covers Vite's dependency optimizer during development.
    resolve: { alias: { 'decode-named-character-reference': workerDecoder } },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://${apiHost}:${apiPort}` } },
    },
  };
});
