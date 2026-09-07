import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@main': resolve('src/main'),
      },
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          // The sherpa-onnx recognizer runs in an Electron utilityProcess; it
          // needs its own entry so main can fork out/main/stt-worker.js.
          'stt-worker': resolve('src/main/services/stt/worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: { '@shared': resolve('src/shared') },
    },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: '.',
    // Bind to 127.0.0.1 explicitly so the dev URL Electron loads matches what
    // Vite listens on (avoids localhost IPv4/IPv6 mismatch -> ERR_CONNECTION_REFUSED
    // on Windows). strictPort surfaces a port conflict instead of silently moving.
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
    },
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@renderer': resolve('src/renderer'),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('index.html'),
        },
      },
    },
  },
});
