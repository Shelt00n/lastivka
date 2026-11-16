import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API_PORT = Number(process.env.API_PORT ?? 3001);

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      // Same origin in dev and prod: the session cookie stays first-party, no CORS needed.
      "/api": { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
});
