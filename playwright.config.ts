import { defineConfig } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const data = mkdtempSync(join(tmpdir(), "connector-browser-"));
process.on("exit", () => rmSync(data, { recursive: true, force: true }));

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 1000 },
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    env: {
      APP_ORIGIN: "http://127.0.0.1:4173",
      HOST: "127.0.0.1",
      PORT: "4173",
      APP_PASSWORD: "connector-browser-test-password",
      PIPELINE_API_KEY: "connector-browser-test-pipeline-key",
      ENCRYPTION_KEY: randomBytes(32).toString("hex"),
      DATA_DIR: data,
      META_APP_ID: "",
      GOOGLE_CLIENT_ID: "",
      X_CLIENT_ID: "",
      LINKEDIN_CLIENT_ID: "",
      TIKTOK_CLIENT_KEY: "",
      THREADS_APP_ID: "",
      REDDIT_CLIENT_ID: "",
      REDDIT_ADS_CLIENT_ID: "",
      PINTEREST_CLIENT_ID: "",
      WORDPRESS_CLIENT_ID: "",
      MICROSOFT_CLIENT_ID: "",
      TIKTOK_BUSINESS_APP_ID: "",
      DISCORD_CLIENT_ID: "",
    },
  },
});
