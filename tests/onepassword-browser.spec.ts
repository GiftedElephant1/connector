import { expect, test, type Page } from "@playwright/test";
import type { OnePasswordLinkInput, OnePasswordSnapshot } from "../server/onepassword-types";

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
  await expect(page.getByRole("heading", { name: "1Password", exact: true })).toBeVisible();
}

async function mockOnePassword(page: Page, options: { enabled?: boolean; failUse?: boolean } = {}) {
  const snapshot: OnePasswordSnapshot = {
    enabled: options.enabled ?? false, executable: "", windows: true, links: [],
    targets: [
      { id: "connection:wordpress-self-hosted", label: "WordPress application password", description: "Connect to the fixed WordPress website you choose.", agentUsable: true, fields: [
        { key: "apiKey", label: "Application password", secret: true, required: true, source: "vault" },
        { key: "username", label: "WordPress username", secret: false, required: true, source: "vault" },
        { key: "siteUrl", label: "WordPress site URL", secret: false, required: true, source: "literal" },
      ] },
      { id: "connection:mailchimp", label: "Mailchimp API key", description: "Connect the selected Mailchimp account.", agentUsable: true, fields: [
        { key: "apiKey", label: "API key", secret: true, required: true, source: "vault" },
      ] },
      { id: "settings:google-workspace", label: "Google app credentials", description: "Google account consent is still required.", agentUsable: false, fields: [
        { key: "GOOGLE_CLIENT_SECRET", label: "Google client secret", secret: true, required: false, source: "vault" },
      ] },
    ],
    principals: [{ id: "key:shared-hash", label: "Shared Connector key" }, { id: "oauth:chatgpt-grant", label: "ChatGPT" }],
  };
  const requests: { method: string; path: string; body: unknown }[] = [];
  let useCount = 0;
  await page.route("**/api/onepassword**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() : null;
    if (method !== "GET") {
      expect(request.headers()["x-connector-request"]).toBe("1");
      requests.push({ method, path, body });
    }
    if (path === "/api/onepassword") {
      if (method === "PUT") { snapshot.enabled = body.enabled; snapshot.executable = body.executable; }
      return route.fulfill({ json: snapshot });
    }
    if (path === "/api/onepassword/check") return route.fulfill({ json: { installed: true, version: "2.32.0", message: "1Password CLI is installed." } });
    if (path === "/api/onepassword/accounts") return route.fulfill({ json: { accounts: [{ id: "account-a", name: "Personal account" }, { id: "account-b", name: "Work account" }] } });
    if (path === "/api/onepassword/vaults") return route.fulfill({ json: { vaults: [{ id: body.accountId === "account-a" ? "vault-a" : "vault-b", name: "Connector credentials" }] } });
    if (path === "/api/onepassword/items") return route.fulfill({ json: { items: [{ id: "item-login", title: "Website login", category: "LOGIN" }, { id: "item-api", title: "Marketing API", category: "API_CREDENTIAL" }] } });
    if (path === "/api/onepassword/fields") return route.fulfill({ json: { fields: [
      { id: "password", label: "Password", type: "CONCEALED", purpose: "PASSWORD" },
      { id: "username", label: "Username", type: "STRING", purpose: "USERNAME" },
      { id: "api-key-field", label: "API key", type: "CONCEALED" },
    ] } });
    if (path === "/api/onepassword/links" && method === "POST") {
      const input = body as OnePasswordLinkInput;
      snapshot.links.push({ ...input, id: `link-${snapshot.links.length + 1}`, targetLabel: snapshot.targets.find(target => target.id === input.targetId)!.label });
      return route.fulfill({ json: snapshot });
    }
    const match = path.match(/^\/api\/onepassword\/links\/([^/]+)(\/use)?$/);
    if (match) {
      const link = snapshot.links.find(item => item.id === match[1])!;
      if (method === "PUT") {
        Object.assign(link, body, { targetLabel: snapshot.targets.find(target => target.id === body.targetId)!.label });
        return route.fulfill({ json: snapshot });
      }
      if (method === "DELETE") {
        snapshot.links = snapshot.links.filter(item => item.id !== match[1]);
        return route.fulfill({ json: snapshot });
      }
      if (match[2]) {
        useCount++;
        if (options.failUse && useCount === 1) return route.fulfill({ status: 409, json: { error: "Unlock 1Password and approve access on the Connector PC, then try again." } });
        link.lastUsedAt = "2026-11-21T01:00:00.000Z";
        return route.fulfill({ json: { id: link.id, name: link.name, target: link.targetLabel, status: "applied", message: "Credential applied to the selected connection. Secret values were not returned." } });
      }
    }
    throw new Error(`Unexpected 1Password request: ${method} ${path}`);
  });
  return { requests, snapshot };
}

async function chooseItem(page: Page) {
  await page.getByRole("button", { name: "Load 1Password accounts", exact: true }).click();
  await page.getByLabel("1Password account", { exact: true }).selectOption("account-a");
  await expect(page.getByLabel("1Password vault", { exact: true })).toBeEnabled();
  await page.getByLabel("1Password vault", { exact: true }).selectOption("vault-a");
  await expect(page.getByLabel("1Password item", { exact: true })).toBeEnabled();
  await page.getByLabel("1Password item", { exact: true }).selectOption("item-login");
  await expect(page.getByLabel("Connector destination", { exact: true })).toBeEnabled();
}

test("1Password setup links metadata with explicit agent permissions and applies credentials without a secret input", async ({ page }) => {
  const f = await mockOnePassword(page);
  await openSettings(page);
  const panel = page.locator("#onepassword");
  await expect(panel.getByRole("button", { name: "Load 1Password accounts", exact: true })).toBeDisabled();
  await expect(panel.getByText("Setup 1Password.vbs", { exact: true })).toBeVisible();
  await panel.getByLabel("Enable 1Password credential retrieval").check();
  await expect(panel.getByRole("button", { name: "Check 1Password CLI", exact: true })).toBeDisabled();
  await panel.getByRole("button", { name: "Save 1Password setup", exact: true }).click();
  await panel.getByRole("button", { name: "Check 1Password CLI", exact: true }).click();
  await expect(panel.getByText("1Password CLI is installed. Version 2.32.0.")).toBeVisible();
  await chooseItem(page);
  await panel.getByLabel("Connector destination", { exact: true }).selectOption("connection:wordpress-self-hosted");
  await panel.getByLabel("Credential link name", { exact: true }).fill("WordPress from vault");
  await panel.getByLabel("Application password", { exact: true }).selectOption("password");
  await panel.getByLabel("WordPress username", { exact: true }).selectOption("username");
  await panel.getByLabel("WordPress site URL", { exact: true }).fill("https://website.example");
  await expect(panel.locator('input[type="password"]')).toHaveCount(0);
  await expect(panel.getByLabel("Shared Connector key", { exact: true })).not.toBeChecked();
  await expect(panel.getByLabel("ChatGPT", { exact: true })).not.toBeChecked();
  // Keyboard selection gives access to only the chosen caller.
  await panel.getByLabel("ChatGPT", { exact: true }).focus();
  await page.keyboard.press("Space");
  await panel.getByRole("button", { name: "Save credential link", exact: true }).click();
  expect(f.requests.find(item => item.path === "/api/onepassword/links")?.body).toEqual({
    name: "WordPress from vault", accountId: "account-a", vaultId: "vault-a", itemId: "item-login", targetId: "connection:wordpress-self-hosted",
    fields: { apiKey: "password", username: "username" }, literals: { siteUrl: "https://website.example" }, principals: ["oauth:chatgpt-grant"],
  });
  const saved = panel.getByRole("article", { name: "WordPress from vault credential link" });
  await expect(saved.getByText("AI access: ChatGPT", { exact: true })).toBeVisible();
  await saved.getByRole("button", { name: "Use now", exact: true }).click();
  await expect(panel.getByRole("status").filter({ hasText: "Credential applied" })).toBeVisible();
  expect(f.requests.find(item => item.path.endsWith("/use"))?.body).toEqual({ confirmed: true });
  await saved.getByRole("button", { name: "Edit link", exact: true }).click();
  await panel.getByLabel("ChatGPT", { exact: true }).uncheck();
  await panel.getByRole("button", { name: "Save link changes", exact: true }).click();
  expect(f.snapshot.links[0].principals).toEqual([]);
  await expect(saved.getByText("AI access: off. Only you can use this link.")).toBeVisible();
  await saved.getByRole("button", { name: "Remove link", exact: true }).click();
  await expect(saved).toHaveCount(0);
  await expect(panel.getByRole("status").filter({ hasText: "Previously imported accounts remain connected" })).toBeVisible();
});

test("changing a 1Password source clears mappings and access, and a locked vault failure remains actionable", async ({ page }) => {
  const f = await mockOnePassword(page, { enabled: true, failUse: true });
  await openSettings(page);
  const panel = page.locator("#onepassword");
  await chooseItem(page);
  await panel.getByLabel("Connector destination", { exact: true }).selectOption("connection:mailchimp");
  await panel.getByLabel("API key", { exact: true }).selectOption("api-key-field");
  await panel.getByLabel("Shared Connector key", { exact: true }).check();
  await panel.getByLabel("1Password item", { exact: true }).selectOption("item-api");
  await expect(panel.getByLabel("API key", { exact: true })).toBeEnabled();
  await expect(panel.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(panel.getByLabel("Shared Connector key", { exact: true })).not.toBeChecked();
  await expect(panel.getByRole("button", { name: "Save credential link", exact: true })).toBeDisabled();
  await panel.getByLabel("API key", { exact: true }).selectOption("api-key-field");
  await panel.getByRole("button", { name: "Save credential link", exact: true }).click();
  const saved = panel.getByRole("article", { name: "Marketing API credential link" });
  await saved.getByRole("button", { name: "Use now", exact: true }).click();
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("Unlock 1Password and approve access");
  await expect(alert).toBeFocused();
  await expect(alert).toBeInViewport();
  await expect(saved.getByRole("button", { name: "Use now", exact: true })).toBeEnabled();
  await saved.getByRole("button", { name: "Use now", exact: true }).click();
  expect(f.requests.filter(item => item.path.endsWith("/use"))).toHaveLength(2);
  await expect(panel.getByRole("status").filter({ hasText: "Credential applied" })).toBeVisible();
  await panel.getByLabel("Enable 1Password credential retrieval").uncheck();
  await panel.getByRole("button", { name: "Save 1Password setup", exact: true }).click();
  await expect(saved.getByRole("button", { name: "Use now", exact: true })).toBeDisabled();
  expect(f.snapshot.links).toHaveLength(1);
});
