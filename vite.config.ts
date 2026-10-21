import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";

// Tests that call startServer without a clientRoot boot Vite in middleware
// mode. Under Vitest they never serve the client, so skip HMR (its websocket
// port) and dependency pre-bundling: the scan errors when a test closes early,
// and parallel servers race to rewrite the shared node_modules/.vite cache.
const underTest = Boolean(process.env.VITEST);

const noPrebundling: Plugin = {
  name: "screencheck:no-prebundling-under-test",
  enforce: "post",
  config(config) {
    // plugin-react adds react to optimizeDeps.include; drop it under test.
    config.optimizeDeps = { ...config.optimizeDeps, include: [] };
  },
};

export default defineConfig({
  plugins: underTest ? [react(), noPrebundling] : [react()],
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
