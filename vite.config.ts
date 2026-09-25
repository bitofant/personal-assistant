import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Also embedded as middleware in dev (server/index.ts): one port, no proxy.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/web", emptyOutDir: true },
});
