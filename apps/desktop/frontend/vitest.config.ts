import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte({
    dynamicCompileOptions: ({ filename }) => filename.endsWith('/stores/app.svelte.ts') ? { generate: 'client' } : undefined,
  })],
  resolve: { conditions: ['browser'] },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
