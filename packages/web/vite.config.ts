import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // e2e/ holds Playwright specs (npm run test:e2e), not vitest tests.
  test: { exclude: ['e2e/**', 'node_modules/**'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:3004',
      // Owner sign-in and sign-out are served by the API; the cookie they set is for this origin.
      '/login': 'http://127.0.0.1:3004',
      '/logout': 'http://127.0.0.1:3004'
    }
  }
})
