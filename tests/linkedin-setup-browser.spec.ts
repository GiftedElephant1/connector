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
}

async function openGuide(page: Page, name = "LinkedIn") {
  await page.getByLabel("Search platforms").fill("LinkedIn");
  const card = page.locator(".provider-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
  await card.getByRole("button", { name: "Check LinkedIn setup", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Register LinkedIn’s exact redirect addresses", { exact: true })).toBeVisible();
  return dialog;
}

test("saved LinkedIn applications can copy both callbacks and match their Client ID without starting OAuth", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  const saved = await page.request.put("/api/settings", {
    headers: { "x-connector-request": "1" },
    data: { values: { LINKEDIN_CLIENT_ID: "browser-linkedin-app", LINKEDIN_CLIENT_SECRET: "browser-linkedin-secret" } },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  let starts = 0;
  await page.route("**/api/oauth/*/start", route => {
    starts++;
    return route.fulfill({ status: 400, json: { error: "Setup should not authorize an account." } });
  });
  await page.route("**/api/settings/providers/*", async route => {
    const result = await route.fetch();
    const settings = await result.json();
    await route.fulfill({ json: { ...settings, callbackUrl: `https://public-connector.example/api/oauth/${settings.id}/callback` } });
  });
  for (const name of ["LinkedIn", "LinkedIn Campaign Manager"]) {
    const dialog = await openGuide(page, name);
    await expect(dialog.getByLabel("LinkedIn Client ID to match in the Auth tab", { exact: true })).toHaveValue("browser-linkedin-app");
    await expect(dialog.getByLabel(/LinkedIn client secret/)).toHaveValue("");
    await expect(dialog.getByText("Authorized redirect URLs for your app", { exact: true })).toBeVisible();
    for (const [label, id] of [["LinkedIn member redirect URL", "linkedin"], ["LinkedIn Campaign Manager redirect URL", "linkedin-ads"]]) {
      await dialog.getByRole("button", { name: `Copy ${label}`, exact: true }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://public-connector.example/api/oauth/${id}/callback`);
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  expect(starts).toBe(0);
});

test("LinkedIn setup withholds public URLs until public access is configured", async ({ page }) => {
  await login(page);
  const dialog = await openGuide(page);
  await expect(dialog.getByText("Start public access in Settings, open the public workspace, and reopen this setup to copy your HTTPS redirect URLs.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("LinkedIn member redirect URL", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Product approval and redirect registration are separate steps.", { exact: false })).toBeVisible();
});

test("reopening LinkedIn setup refreshes changed public URLs and fits a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await login(page);
  let origin = "https://previous-public.example";
  await page.route("**/api/settings/providers/linkedin", async route => {
    const result = await route.fetch();
    await route.fulfill({ json: { ...await result.json(), callbackUrl: `${origin}/api/oauth/linkedin/callback` } });
  });
  let dialog = await openGuide(page);
  await expect(dialog.getByLabel("LinkedIn member redirect URL", { exact: true })).toHaveValue(`${origin}/api/oauth/linkedin/callback`);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  origin = "https://current-public.example";
  dialog = await openGuide(page);
  await expect(dialog.getByLabel("LinkedIn member redirect URL", { exact: true })).toHaveValue(`${origin}/api/oauth/linkedin/callback`);
  await expect(dialog.getByLabel("LinkedIn Campaign Manager redirect URL", { exact: true })).toHaveValue(`${origin}/api/oauth/linkedin-ads/callback`);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});

test("LinkedIn setup shows the actual requested permissions and optional approval switches", async ({ page }) => {
  await login(page);
  const headers = { "x-connector-request": "1" };
  const flags = { LINKEDIN_ENABLE_MEMBER_READ: "false", LINKEDIN_ENABLE_CONVERSIONS: "false" };
  expect((await page.request.put("/api/settings", { headers, data: { values: { ...flags, LINKEDIN_CLIENT_ID: "browser-linkedin-app", LINKEDIN_CLIENT_SECRET: "browser-linkedin-secret" } } })).ok()).toBe(true);
  await page.reload();
  try {
    for (const [name, provider, label, base, optional] of [
      ["LinkedIn", "linkedin", "Approved LinkedIn member reading", "openid profile w_member_social", "r_member_social"],
      ["LinkedIn Campaign Manager", "linkedin-ads", "Approved LinkedIn conversion uploads", "r_ads rw_ads r_ads_reporting", "rw_conversions"],
    ]) {
      const dialog = await openGuide(page, name);
      await expect(dialog.getByLabel("Permissions Connector will request", { exact: true })).toHaveValue(base);
      if (provider === "linkedin") {
        await expect(dialog.getByText("Sign In with LinkedIn using OpenID Connect", { exact: true })).toBeVisible();
        await expect(dialog.getByText(/r_basicprofile does not replace openid or profile/)).toBeVisible();
      }
      await dialog.getByLabel(label, { exact: false }).selectOption("true");
      const expected = `${base} ${optional}`;
      await expect(dialog.getByLabel("Permissions Connector will request", { exact: true })).toHaveValue(expected);
      await dialog.getByRole("button", { name: "Save and continue", exact: true }).click();
      await expect(dialog).toHaveCount(0);
      // Compare the displayed scope list with the actual authorization request,
      // without navigating to LinkedIn or touching a real account.
      const started = await page.request.post(`/api/oauth/${provider}/start`, { headers });
      expect(started.ok()).toBe(true);
      expect(new URL((await started.json()).url).searchParams.get("scope")).toBe(expected);
    }
  } finally {
    await page.request.put("/api/settings", { headers, data: { values: flags } });
  }
});
