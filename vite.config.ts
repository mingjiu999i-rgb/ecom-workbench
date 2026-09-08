import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'

export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [tailwindcss()] } },
  build: {
    rollupOptions: {
      output: { manualChunks: { supabase: ['@supabase/supabase-js'] } },
    },
  },
})
