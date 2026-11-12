import { defineConfig } from "@playwright/test";

// Browser-level checks against synthetic servers only (see ../api/scripts/login-e2e-server.ts).
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:47831" },
  webServer: {
    command: "../api/node_modules/.bin/tsx ../api/scripts/login-e2e-server.ts",
    url: "http://127.0.0.1:47831/health",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
