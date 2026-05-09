import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const MAE_API = process.env.MAE_API_URL ?? process.env.MAE_DASHBOARD_URL ?? "http://localhost:8400";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": {
        target: MAE_API,
        changeOrigin: true,
        ws: false,
      },
      "/metrics": {
        target: MAE_API,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
  },
});
