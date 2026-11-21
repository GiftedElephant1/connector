import { expect, test, type Page } from "@playwright/test";
import type { BrowserConfiguration, BrowserSnapshot } from "../server/browser-types";
import type { OnePasswordSnapshot } from "../server/onepassword-types";

async function openSettings(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("connector-browser-test-password");
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your accounts, connected\.|First, make this workspace yours\./ })).toBeVisible();
  if (await page.getByLabel("Choose a password", { exact: true }).isVisible()) {
    await page.getByLabel("Choose a password", { exact: true }).fill("connector-browser-test-password");
    await page.getByLabel("Repeat your password", { exact: true }).fill("connector-browser-test-password");
    await page.getByRole("button", { name: "Save password and continue" }).click();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("link", { name: "Manage 1Password credentials ↓" }).click();
  await expect(page.getByRole("heading", { name: "Browser access for AI agents", exact: true })).toBeVisible();
}

async function mockBrowser(page: Page, options: { onePasswordEnabled?: boolean; enabled?: boolean; session?: boolean; failSave?: boolean; expireCheck?: boolean } = {}) {
  const state: BrowserSnapshot = {
    enabled: options.enabled ?? false, browser: "auto", principals: options.enabled ? ["key:shared"] : [],
    onePasswordEnabled: options.onePasswordEnabled ?? true,
    availablePrincipals: [{ id: "key:shared", label: "Shared Connector API key" }, { id: "oauth:grok", label: "Grok Bot" }],
    sessions: options.session ? [{ id: "session-one", principalLabel: "Shared Connector API key", origin: "https://example.com", lastUsedAt: "2026-11-21T02:30:00.000Z" }] : [],
  };
  const onePassword: OnePasswordSnapshot = { enabled: state.onePasswordEnabled, executable: "", windows: true, links: [], targets: [], principals: state.availablePrincipals };
  const requests: { path: string; method: string; body: unknown }[] = [];
  let saveCount = 0;
  await page.route("**/api/onepassword**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : null;
    requests.push({ path, method: req.method(), body });
    if (path !== "/api/onepassword") throw new Error(`Browser setup unexpectedly tried per-item setup: ${path}`);
    if (req.method() === "PUT") {
      onePassword.enabled = body.enabled;
      onePassword.executable = body.executable;
      state.onePasswordEnabled = body.enabled;
    }
    return route.fulfill({ json: onePassword });
  });
  await page.route("**/api/browser**", async route => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const body = req.postData() ? req.postDataJSON() : null;
    requests.push({ path, method, body });
    if (method !== "GET") expect(req.headers()["x-connector-request"]).toBe("1");
    if (path === "/api/browser") {
      if (method === "PUT") {
        saveCount++;
        if (options.failSave && saveCount === 1) return route.fulfill({ status: 409, json: { error: "Browser access changed. Refresh and try again." } });
        const input = body as BrowserConfiguration;
        state.enabled = input.enabled; state.browser = input.browser; state.principals = input.principals; state.sessions = [];
      }
      return route.fulfill({ json: state });
    }
    if (path === "/api/browser/check") {
      if (options.expireCheck) return route.fulfill({ status: 401, json: { error: "Session expired." } });
      return route.fulfill({ json: { installed: true, name: "Microsoft Edge", message: "Microsoft Edge is installed. An allowed AI can open a browser window through Connector." } });
    }
    if (path === "/api/browser/close-all") { state.sessions = []; return route.fulfill({ json: state }); }
    throw new Error(`Unexpected managed-browser request: ${method} ${path}`);
  });
  return { state, requests };
}

test("browser access enables all-vault live matching once for selected AI connections without per-item setup", async ({ page }) => {
  const f = await mockBrowser(page, { onePasswordEnabled: false });
  await openSettings(page);
  const panel = page.getByRole("region", { name: "Browser access for AI agents", exact: true });
  await expect(panel.getByLabel("Enable browser access with live 1Password")).toBeDisabled();
  await expect(panel.getByText(/searches every vault/)).toBeVisible();
  await page.getByLabel("Enable 1Password credential retrieval", { exact: true }).check();
  await page.getByRole("button", { name: "Save 1Password setup", exact: true }).click();
  await expect(panel.getByLabel("Enable browser access with live 1Password")).toBeEnabled();
  await panel.getByLabel("Enable browser access with live 1Password").check();
  await expect(panel.getByRole("button", { name: "Save browser access", exact: true })).toBeDisabled();
  await expect(panel.getByLabel("Shared Connector API key", { exact: true })).not.toBeChecked();
  await expect(panel.getByLabel("Grok Bot", { exact: true })).not.toBeChecked();
  await panel.getByLabel("Grok Bot", { exact: true }).focus();
  await page.keyboard.press("Space");
  await panel.getByLabel("Browser", { exact: true }).selectOption("edge");
  await expect(panel.getByRole("button", { name: "Check browser", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Save browser access", exact: true }).click();
  expect(f.requests.find(req => req.path === "/api/browser" && req.method === "PUT")?.body).toEqual({ enabled: true, browser: "edge", principals: ["oauth:grok"] });
  await expect(panel.getByRole("status").filter({ hasText: "Browser access saved" })).toBeVisible();
  await panel.getByRole("button", { name: "Check browser", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Microsoft Edge is installed" })).toBeVisible();
  expect(f.requests.some(req => req.path === "/api/onepassword/accounts")).toBe(false);
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
});

test("owner can close browser windows without discarding pending permission changes, then revoke access", async ({ page }) => {
  const f = await mockBrowser(page, { enabled: true, session: true });
  await openSettings(page);
  const panel = page.getByRole("region", { name: "Browser access for AI agents", exact: true });
  await expect(panel.getByRole("article", { name: "Shared Connector API key browser session" })).toContainText("https://example.com");
  await panel.getByLabel("Shared Connector API key", { exact: true }).uncheck();
  await panel.getByLabel("Grok Bot", { exact: true }).check();
  await panel.getByRole("button", { name: "Close all browser windows", exact: true }).click();
  expect(f.requests.find(req => req.path === "/api/browser/close-all")?.body).toEqual({ confirmed: true });
  await expect(panel.getByLabel("Grok Bot", { exact: true })).toBeChecked();
  await expect(panel.getByLabel("Shared Connector API key", { exact: true })).not.toBeChecked();
  await expect(panel.getByRole("article")).toHaveCount(0);
  await panel.getByLabel("Enable browser access with live 1Password").uncheck();
  await panel.getByRole("button", { name: "Save browser access", exact: true }).click();
  expect(f.state.enabled).toBe(false);
  await expect(panel.getByRole("status").filter({ hasText: "Browser access is off" })).toBeVisible();
});

test("failed browser settings remain visible and can be retried without losing the selected connection", async ({ page }) => {
  const f = await mockBrowser(page, { failSave: true });
  await openSettings(page);
  const panel = page.getByRole("region", { name: "Browser access for AI agents", exact: true });
  await panel.getByLabel("Enable browser access with live 1Password").check();
  await panel.getByLabel("Grok Bot", { exact: true }).check();
  await panel.getByRole("button", { name: "Save browser access", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Browser access changed. Refresh and try again.");
  await expect(panel.getByRole("alert")).toBeFocused();
  await expect(panel.getByRole("alert")).toBeInViewport();
  await expect(panel.getByLabel("Grok Bot", { exact: true })).toBeChecked();
  await panel.getByRole("button", { name: "Save browser access", exact: true }).click();
  expect(f.state.principals).toEqual(["oauth:grok"]);
  await expect(panel.getByRole("status").filter({ hasText: "Browser access saved" })).toBeVisible();
});

test("browser setup returns to Connector sign-in when the owner session expires", async ({ page }) => {
  await mockBrowser(page, { expireCheck: true });
  await openSettings(page);
  const panel = page.getByRole("region", { name: "Browser access for AI agents", exact: true });
  await panel.getByRole("button", { name: "Check browser", exact: true }).click();
  await expect(page.getByLabel("Workspace password", { exact: true })).toBeVisible();
  await expect(page.getByText("Your session has expired. Please sign in again.", { exact: true })).toBeVisible();
});
