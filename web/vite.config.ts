import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// https://vite.dev/config/
export default defineConfig(({ command, isPreview }) => ({
  plugins: [react()],
  // Production build (and `vite preview` of it) is served from the portfolio at raulesteveza.github.io/tools/Mapper/
  base: command === 'build' || isPreview ? '/tools/Mapper/' : '/',
  test: {
    // Core tests run in Node; interface tests opt into jsdom with a comment at the top of the file
    environment: 'node',
  },
}))
