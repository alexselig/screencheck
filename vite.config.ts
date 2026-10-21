import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";

// Tests that call startServer without a clientRoot boot Vite in middleware
// mode. Under Vitest they never need HMR or dependency pre-bundling, so skip
// the websocket port and the scan (which errors when a test closes early).
const underTest = Boolean(process.env.VITEST);

export default defineConfig({
  plugins: [react()],
  ...(underTest
    ? {
        server: { hmr: false, ws: false },
        optimizeDeps: { noDiscovery: true },
      }
    : {}),
  build: {
    outDir: "dist/client",
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude, ".worktrees/**"],
  },
});
