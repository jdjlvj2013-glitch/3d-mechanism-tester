import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './', // relative paths: works on any static host / subpath
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        name: '3D Mechanism Tester',
        short_name: 'MechTest',
        description: 'Test 3D-printed mechanisms offline: STL/3MF parts, joints, motion, collisions, tolerances.',
        start_url: './',
        scope: './',
        display: 'standalone',
        background_color: '#1e1e1e',
        theme_color: '#1e1e1e',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,wasm,woff2}', 'models/**/*', 'samples/**/*'],
        maximumFileSizeToCacheInBytes: 20 * 1024 * 1024, // three.js chunks
        navigateFallback: 'index.html',
      },
    }),
  ],
});
