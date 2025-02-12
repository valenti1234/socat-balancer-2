import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { // Proxy requests starting with /api
        target: 'http://172.16.20.63:5000', // URL of your backend server
        changeOrigin: true, // Required for CORS in some cases
       // rewrite: (path) => path.replace(/^\/api/, ''), // Optional: remove /api from the path
      },
      '/auth': {  // Example for another proxy path
        target: 'http://172.16.20.63:5000',
        changeOrigin: true,
      },
       '/socket.io': { // Proxy for WebSockets (example)
        target: 'ws://172.16.20.63:5000',
        ws: true,
      },
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
