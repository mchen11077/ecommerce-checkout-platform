import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.COUPON_VITE_BACKEND ?? 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': backend, '/oauth2': backend, '/login': backend, '/logout': backend },
  },
});
