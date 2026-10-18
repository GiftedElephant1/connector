import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("connector-browser-test-password");
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your accounts, connected\.|First, make this workspace yours\./ })).toBeVisible();
  if (await page.getByLabel("Choose a password", { exact: true }).isVisible()) {
    await page.getByLabel("Choose a password", { exact: true }).fill("connector-browser-test-password");
    await page.getByLabel("Repeat your password", { exact: true }).fill("connector-browser-test-password");
    await page.getByRole("button", { name: "Save password and continue" }).click();
  }
  await expect(page.getByRole("heading", { name: "Your accounts, connected." })).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
}

async function openSetup(page: Page, name: string) {
  const row = page.locator(".settings-providers > div").filter({ has: page.locator("strong").filter({ hasText: new RegExp(`^${name}$`) }) });
  await row.getByRole("button", { name: "Manage setup", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Register both TikTok for Business redirect URLs", { exact: true })).toBeVisible();
  return dialog;
}

test("TikTok Business setup copies both distinct callbacks with the required holder slash", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  let starts = 0;
  await page.route("**/api/oauth/*/start", route => {
    starts++;
    return route.fulfill({ status: 400, json: { error: "Opening setup should not start authorization." } });
  });
  await page.route("**/api/settings/providers/*", async route => {
    const response = await route.fetch();
    const settings = await response.json();
    await route.fulfill({ json: { ...settings, callbackUrl: `https://public-connector.example/api/oauth/${settings.id}/callback` } });
  });
  const dialog = await openSetup(page, "TikTok Business Manager");
  for (const [label, path] of [
    ["Advertiser redirect URL", "/api/oauth/tiktok-business/callback"],
    ["TikTok account holder redirect URL", "/api/oauth/tiktok-business-account/callback/"],
  ]) {
    await expect(dialog.getByLabel(label, { exact: true })).toHaveValue(`https://public-connector.example${path}`);
    await dialog.getByRole("button", { name: `Copy ${label}`, exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://public-connector.example${path}`);
  }
  await expect(dialog.getByText(/These Business callbacks are separate from TikTok for Developers Login Kit/)).toBeVisible();
  expect(starts).toBe(0);
});

test("account holder authorization saves edits before navigation and manages only the companion", async ({ page }) => {
  await login(page);
  let connected = false;
  let saved: Record<string, string> = {};
  const events: string[] = [];
  await page.route("**/api/settings/providers/tiktok-business", async route => {
    const response = await route.fetch();
    const settings = await response.json();
    await route.fulfill({ json: {
      ...settings,
      callbackUrl: "http://127.0.0.1:4173/api/oauth/tiktok-business/callback",
      fields: [
        { key: "TIKTOK_BUSINESS_APP_ID", label: "TikTok Business app ID", secret: false, configured: !!saved.TIKTOK_BUSINESS_APP_ID, value: saved.TIKTOK_BUSINESS_APP_ID, providerIds: ["tiktok-business"] },
        { key: "TIKTOK_BUSINESS_APP_SECRET", label: "TikTok Business app secret", secret: true, configured: !!saved.TIKTOK_BUSINESS_APP_SECRET, providerIds: ["tiktok-business"] },
        { key: "TIKTOK_BUSINESS_ACCOUNT_AUTH_URL", label: "TikTok account holder authorization URL", secret: false, configured: !!saved.TIKTOK_BUSINESS_ACCOUNT_AUTH_URL, value: saved.TIKTOK_BUSINESS_ACCOUNT_AUTH_URL, providerIds: ["tiktok-business"] },
      ],
      companion: { id: "tiktok-business-account", name: "TikTok account holder", connection: connected ? { accountName: "Example account holder", status: "connected" } : null },
    } });
  });
  await page.route("**/api/settings", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    events.push("save");
    saved = route.request().postDataJSON().values;
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/oauth/tiktok-business-account/start", async route => {
    events.push("start");
    expect(saved.TIKTOK_BUSINESS_APP_ID).toBe("browser-business-app");
    expect(saved.TIKTOK_BUSINESS_APP_SECRET).toBe("browser-business-secret");
    await route.fulfill({ json: { url: "https://holder-authorization.example/authorize" } });
  });
  await page.route("https://holder-authorization.example/authorize", route => route.fulfill({ contentType: "text/html", body: "<h1>Test authorization destination</h1>" }));
  await page.route("**/api/connections/tiktok-business-account/verify", async route => {
    events.push("verify");
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/connections/*", async route => {
    if (route.request().method() !== "DELETE") return route.continue();
    events.push(`disconnect:${new URL(route.request().url()).pathname}`);
    connected = false;
    await route.fulfill({ json: { ok: true } });
  });
  let dialog = await openSetup(page, "TikTok Business Manager");
  await dialog.getByLabel("TikTok Business app ID", { exact: true }).fill("browser-business-app");
  await dialog.getByLabel("TikTok Business app secret", { exact: true }).fill("browser-business-secret");
  await dialog.getByLabel("TikTok account holder authorization URL", { exact: true }).fill("https://www.tiktok.com/v2/auth/authorize/?client_key=browser-business-app");
  await dialog.getByRole("button", { name: "Connect TikTok account holder", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Test authorization destination" })).toBeVisible();
  expect(events).toEqual(["save", "start"]);

  connected = true;
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  dialog = await openSetup(page, "TikTok Business Manager");
  await expect(dialog.getByText("Connected: Example account holder", { exact: true })).toBeVisible();
  await expect(dialog.getByText(/does not add posting actions or other account holder tools/)).toBeVisible();
  await dialog.getByRole("button", { name: "Verify TikTok account holder", exact: true }).click();
  await expect.poll(() => events).toEqual(["save", "start", "verify"]);
  await dialog.getByRole("button", { name: "Disconnect TikTok account holder", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Connect TikTok account holder", exact: true })).toBeVisible();
  await expect(dialog.getByText("Connected: Example account holder", { exact: true })).toHaveCount(0);
  expect(events).toEqual(["save", "start", "verify", "disconnect:/api/connections/tiktok-business-account"]);
});

test("TikTok Business setup withholds local and custom-port callbacks and fits a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await login(page);
  let dialog = await openSetup(page, "TikTok Business Manager");
  await expect(dialog.getByText("Start public access in Settings, then reopen this setup to copy your HTTPS redirect URLs.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Advertiser redirect URL", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("TikTok account holder redirect URL", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.route("**/api/settings/providers/tiktok-business", async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), callbackUrl: "https://public-connector.example:8443/api/oauth/tiktok-business/callback" } });
  });
  dialog = await openSetup(page, "TikTok Business Manager");
  await expect(dialog.getByLabel("TikTok account holder redirect URL", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/TikTok account holder redirects require HTTPS without a custom port/)).toBeVisible();
});
