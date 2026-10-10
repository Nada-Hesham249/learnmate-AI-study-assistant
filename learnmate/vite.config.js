import process from 'node:process'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Read .env / .env.local without the VITE_ prefix so the API key stays on the
  // dev server and is never bundled into browser code.
  const env = loadEnv(mode, process.cwd(), '')
  const apiUrl = (env.LEARNMATE_API_URL || '').replace(/\/+$/, '')

  if (!apiUrl || !env.LEARNMATE_API_KEY) {
    console.warn(
      '\n[LearnMate] Set LEARNMATE_API_URL and LEARNMATE_API_KEY in learnmate/.env.local ' +
        '(see .env.example), then restart `npm run dev`.\n'
    )
  }

  return {
    plugins: [react()],
    server: {
      proxy: {
        // /api/chat -> <Kaggle ngrok URL>/chat, with the API key added here.
        '/api': {
          target: apiUrl || 'http://127.0.0.1:8000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
          headers: {
            'X-API-Key': env.LEARNMATE_API_KEY || '',
            'ngrok-skip-browser-warning': 'true',
          },
          // Model answers on Kaggle can take minutes.
          timeout: 600000,
          proxyTimeout: 600000,
        },
      },
    },
  }
})
