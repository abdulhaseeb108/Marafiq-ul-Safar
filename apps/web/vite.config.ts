import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const sharedSource = fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Tests run against shared source so they do not need a prior build.
    alias: mode === 'test' ? [{ find: '@marafiq/shared', replacement: sharedSource }] : [],
  },
  build: {
    // The public bundle is ~160 KB gzipped (Lighthouse 99 at 360px); admin loads separately.
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5175,
    strictPort: true,
    // The flow test (npm run e2e:flow) points this at its own API with VITE_API_PROXY.
    proxy: { '/api': process.env.VITE_API_PROXY ?? 'http://localhost:4002' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // Playwright owns e2e/; Vitest runs the unit tests in src/.
    include: ['src/**/*.test.{ts,tsx}'],
  },
}));
