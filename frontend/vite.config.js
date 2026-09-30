import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: resolve(__dirname, '../dist/frontend'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        listener: resolve(__dirname, 'listener/index.html'),
        publisher: resolve(__dirname, 'publisher/index.html'),
        studio: resolve(__dirname, 'studio/index.html'),
        admin: resolve(__dirname, 'admin/index.html'),
      },
    },
  },
});
