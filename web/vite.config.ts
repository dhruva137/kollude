import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Relative base so the static build works from any host path (GitHub Pages, a USB stick
// served by `vite preview`, the shared demo machine). Data is fetched via BASE_URL too.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: true } },
  },
})
