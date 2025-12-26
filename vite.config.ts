import { defineConfig } from 'vite'
import path from 'node:path'
import electron from 'vite-plugin-electron/simple'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // Build both main UI and overlay UI into dist/ (multi-page)
  build: {
    rollupOptions: {
      input: {
        main: path.join(__dirname, 'index.html'),
        overlay: path.join(__dirname, 'overlay.html'),
      },
    },
  },
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'src/main/index.ts',
        vite: {
            build: {
                outDir: 'dist-electron',
                rollupOptions: {
                    external: ['robotjs', 'screenshot-desktop', 'jimp', 'openai']
                }
            }
        }
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'src/preload/index.ts'),
        vite: {
            build: {
                outDir: 'dist-electron/preload',
            }
        }
      },
      // Ployfill the Electron and Node.js built-in modules for Renderer process.
      // See 👉 https://github.com/electron-vite/vite-plugin-electron-renderer
      renderer: {},
    }),
  ],
})
