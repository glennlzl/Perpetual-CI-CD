import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'client',
  base: '/build/',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./client/src', import.meta.url)) } },
  build: { outDir: '../public/build', emptyOutDir: true, sourcemap: false },
});
