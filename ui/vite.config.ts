import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    host: true,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      "agi.atomicwork.in",
      "chat.atomicwork.in",
      "itsm.mlinterviewnotes.com",
    ],
    // WSL2 /mnt/ drives don't support inotify — fall back to polling so HMR works
    watch: process.cwd().startsWith("/mnt/") ? { usePolling: true, interval: 1000 } : undefined,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        ws: true,
      },
    },
  },
});
