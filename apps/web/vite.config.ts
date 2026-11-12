import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // У REST API не включён CORS, поэтому в dev проксируем запросы через Vite.
    // Контракт остаётся прежним: /api/v1/* уходит на API Gateway :3001.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      // В production этот путь проксирует reverse proxy (Caddy/Nginx),
      // в dev — Vite.
      '/socket.io': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
