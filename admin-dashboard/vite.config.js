import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy in development so the SPA and the API share an origin and CORS
    // never gets in the way locally.
    proxy: {
      '/api': { target: process.env.VITE_API_TARGET || 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
