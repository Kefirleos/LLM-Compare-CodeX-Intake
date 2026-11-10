import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  const apiPort = env.PORT || '3001';
  const apiHost = env.HOST === '0.0.0.0' ? '127.0.0.1' : env.HOST || '127.0.0.1';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://${apiHost}:${apiPort}` } },
    },
  };
});
