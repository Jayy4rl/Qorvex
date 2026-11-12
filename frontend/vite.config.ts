/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the Qorvex backend (npm start / npm run demo) serves the API on :8787.
// Production builds are served by that same backend from frontend/dist, so /api is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.QORVEX_API ?? "http://localhost:8787", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: false, target: "es2022" },
  test: { environment: "node", include: ["src/test/**/*.test.{ts,tsx}"] },
});
