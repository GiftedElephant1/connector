import { expect, test, type Page } from "@playwright/test";
import profile from "../client/public-profile.json" with { type: "json" };

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
}

async function openProvider(page: Page, name: string) {
  const item = page.locator(".settings-providers > div").filter({ has: page.getByText(name, { exact: true }) });
  await item.getByRole("button", { name: "Manage setup", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("region", { name: "Google setup guide" })).toBeVisible();
  return dialog;
}

test("all Google platform guides separate public branding from real callbacks without changing credentials or starting OAuth", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  let mutationCount = 0;
  await page.route("**/api/**", async route => {
    if (!["GET", "HEAD"].includes(route.request().method())) mutationCount++;
    await route.continue();
  });
  const runtime = "https://running-workspace.example";
  await page.route("**/api/settings/providers/*", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, callbackUrl: `${runtime}/api/oauth/${body.id}/callback` } });
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  for (const name of ["YouTube", "Google Ads", "Google Analytics", "Google Search Console"]) {
    const dialog = await openProvider(page, name);
    const guide = dialog.getByRole("region", { name: "Google setup guide" });
    for (const [label, value] of [
      ["Google application home page", `${profile.siteUrl}/`],
      ["Google privacy policy URL", `${profile.siteUrl}/privacy/`],
      ["Google terms of service URL", `${profile.siteUrl}/terms/`],
      ["Google authorized domain", "vectrepay.com"],
      ["YouTube redirect URI", `${runtime}/api/oauth/youtube/callback`],
      ["Google Ads redirect URI", `${runtime}/api/oauth/google-ads/callback`],
      ["Google Analytics redirect URI", `${runtime}/api/oauth/google-analytics/callback`],
      ["Google Search Console redirect URI", `${runtime}/api/oauth/search-console/callback`],
      ["Google Workspace redirect URI", `${runtime}/api/workspace/google/callback`],
    ]) {
      await expect(guide.getByLabel(label, { exact: true })).toHaveValue(value);
      await guide.getByRole("button", { name: `Copy ${label}`, exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(value);
    }
    await expect(dialog.getByLabel(/Google OAuth client secret/)).toHaveValue("");
    await expect(guide.getByText(/Never replace their host with the static public website’s address/)).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  expect(mutationCount).toBe(0);
});

test("Google setup withholds local callback values and explains publication, domain, audience, and review requirements", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = await openProvider(page, "YouTube");
  const guide = dialog.getByRole("region", { name: "Google setup guide" });
  await expect(guide.getByText("Start public access in Connector Settings, then reopen this setup to copy the running workspace’s HTTPS redirect URIs.", { exact: true })).toBeVisible();
  await expect(guide.getByLabel("YouTube redirect URI", { exact: true })).toHaveCount(0);
  await guide.getByText("1. Publish and verify the public website", { exact: true }).click();
  await expect(guide.getByText(/not a confirmation that deployment or verification has finished/)).toBeVisible();
  await expect(guide.getByText("GiftedElephant1.github.io", { exact: true })).toBeVisible();
  await expect(guide.getByRole("link", { name: "Google Search Console ↗", exact: true })).toHaveAttribute("href", "https://search.google.com/search-console");
  await guide.getByText("3. Choose the audience and permissions", { exact: true }).click();
  await expect(guide.getByText(/403: org_internal/)).toBeVisible();
  await expect(guide.getByText(/refresh tokens that expire after seven days/)).toBeVisible();
  await expect(guide.getByText(/Branding verification and sensitive or restricted scope verification are separate reviews/)).toBeVisible();
  await guide.getByText("5. Recheck and submit for review", { exact: true }).click();
  await expect(guide.getByText(/Do not use Disable and reset to fix branding/)).toBeVisible();
});

test("Workspace setup shares the guide, derives callbacks from its current origin, and fits a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await login(page);
  await page.route("**/api/workspace", async route => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ json: { ...body, google: { ...body.google, configured: false, callbackUrl: "https://current-workspace.ngrok-free.dev/api/workspace/google/callback" } } });
  });
  await page.getByRole("button", { name: "Google Workspace", exact: true }).click();
  const guide = page.getByRole("region", { name: "Google setup guide" });
  await expect(guide.getByLabel("Google Workspace redirect URI", { exact: true })).toHaveValue("https://current-workspace.ngrok-free.dev/api/workspace/google/callback");
  await expect(guide.getByLabel("YouTube redirect URI", { exact: true })).toHaveValue("https://current-workspace.ngrok-free.dev/api/oauth/youtube/callback");
  await expect(guide.getByLabel("Google privacy policy URL", { exact: true })).toHaveValue(`${profile.siteUrl}/privacy/`);
  await expect(guide.getByText(/Your running workspace still uses ngrok/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await guide.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
