import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', 'POB_');
  const backend = `http://127.0.0.1:${env.POB_BACKEND_PORT || 8765}`;
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: Number(env.POB_FRONTEND_PORT || 5173),
      proxy: { '/api': backend, '/ws': { target: backend, ws: true } },
    },
    build: { outDir: 'dist', chunkSizeWarningLimit: 900 },
  };
});
