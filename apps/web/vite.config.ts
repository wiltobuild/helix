import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const daemon = `http://127.0.0.1:${process.env.HELIX_PORT ?? '4317'}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    strictPort: true,
    // helixd allows the Vite origin (http://localhost:5317); proxying keeps the app same-origin.
    proxy: {
      '/api': { target: daemon },
      '/mux': { target: daemon.replace('http', 'ws'), ws: true },
    },
  },
});
