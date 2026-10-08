import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    server: {
      // Keeps the API same-origin in dev, so the frontend calls relative /api
      // paths and CORS stays a production-only concern.
      proxy: {
        '/api': {
          target: 'http://localhost:4000',
          changeOrigin: true,
          // The backend serves its routes at the root (/auth/login), the
          // frontend calls them under /api.
          rewrite: (path) => path.replace(/^\/api/, ''),
          // The refresh cookie is scoped to the backend's /auth path; seen
          // through the proxy that path is /api/auth, or the browser would
          // never send it back to /api/auth/refresh.
          cookiePathRewrite: { '/auth': '/api/auth' },
        },
      },
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
