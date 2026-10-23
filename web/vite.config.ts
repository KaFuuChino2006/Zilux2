import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// base: './' 使产物可被 https://zilux2.local/index.html 这类虚拟主机以相对路径加载。
export default defineConfig({
  base: './',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
      },
    },
  },
});
