import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';

export default defineConfig(({mode}) => {
  // loadEnv with an empty prefix reads EVERY variable from .env, including ones
  // without the VITE_ prefix. That matters: API_KEY must NOT be named
  // VITE_API_KEY, because the VITE_ prefix inlines a value into the public
  // browser bundle where anyone can read it out of devtools. Here the key is
  // used only inside the dev server process and is attached to proxied requests
  // server-side, so it never reaches the browser.
  const env = loadEnv(mode, process.cwd(), '');
  const apiTarget = env.API_BASE_URL || 'http://localhost:3001';
  const apiKey = env.API_KEY || '';

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      proxy: {
        // The SPA calls the relative path /api/... ; this forwards to the
        // backend and injects the credential. Production uses an equivalent
        // Netlify proxy so the frontend code is identical in both.
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) proxyReq.setHeader('X-Api-Key', apiKey);
            });
          },
        },
      },
    },
  };
});
