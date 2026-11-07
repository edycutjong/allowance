import { defineConfig, devices } from "@playwright/test";

// Static pages (landing, deck, judge) served from public/ exactly as Vercel serves them.
// Set BASE_URL=https://allowance.edycu.dev to run the same suite against production.
const base = process.env.BASE_URL ?? "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: base, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : { command: "python3 -m http.server 4173 --bind 127.0.0.1 --directory public", url: base, reuseExistingServer: !process.env.CI, timeout: 15_000 },
});
