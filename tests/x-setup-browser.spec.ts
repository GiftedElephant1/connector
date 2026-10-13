import { expect, test, type Page } from "@playwright/test";

async function openXSetup(page: Page) {
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
  await page.getByLabel("Search platforms").fill("X (Twitter)");
  const card = page.locator(".provider-card").filter({ has: page.getByRole("heading", { name: "X (Twitter)", exact: true }) });
  await card.getByRole("button", { name: "Connect account", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Set up X step by step", exact: true }).click();
  return dialog;
}

test("X first-time setup explains registration and credentials while withholding local callback URLs", async ({ page }) => {
  const dialog = await openXSetup(page);
  await expect(dialog.getByText("Start public access in Settings before copying X application URLs.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "2. Sign in to X or create an X account", exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Open X Developer Portal", exact: false })).toHaveAttribute("href", "https://developer.x.com/");
  await expect(dialog.getByLabel("X callback / redirect URL", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("The separate", { exact: false }).filter({ hasText: "Bearer Token" })).toBeVisible();
  await expect(dialog.getByLabel("X OAuth client ID", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("X OAuth client secret", { exact: true })).toHaveAttribute("type", "password");
  await expect(dialog.getByRole("button", { name: "Save and continue", exact: true })).toBeVisible();
});

test("X guide copies the actual callback, legal URLs and truthful single-owner use case", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/legal", (route) => route.fulfill({ json: {
    configured: true, operatorName: "Vectre Pay Inc", contactEmail: "contact@vectrepay.com", publicOrigin: "https://review-connector.example",
    aboutUrl: "https://review-connector.example/about", termsUrl: "https://review-connector.example/terms", privacyUrl: "https://review-connector.example/privacy",
  } }));
  const dialog = await openXSetup(page);
  await dialog.getByRole("button", { name: "Copy X callback / redirect URL", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://review-connector.example/api/oauth/x/callback");
  await expect(dialog.getByLabel("X Terms of Service URL", { exact: true })).toHaveValue("https://review-connector.example/terms");
  await expect(dialog.getByLabel("X Privacy Policy URL", { exact: true })).toHaveValue("https://review-connector.example/privacy");
  await expect(dialog.getByLabel("X organization name (if requested)", { exact: true })).toHaveValue("Vectre Pay Inc");
  await dialog.getByRole("button", { name: "Copy X use-case description", exact: true }).click();
  const description = await page.evaluate(() => navigator.clipboard.readText());
  expect(description).toContain("private, single-owner Connector installation for Vectre Pay Inc");
  expect(description).toContain("Authorized AI assistants receive the tool results");
  for (const scope of ["tweet.read", "tweet.write", "users.read", "dm.read", "dm.write", "offline.access"]) {
    await expect(dialog.locator(".x-scope-list dt").filter({ hasText: scope })).toBeVisible();
  }
});

test("X setup remains readable on a phone and can retry loading public details", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  let calls = 0;
  await page.route("**/api/legal", (route) => {
    calls += 1;
    return calls === 1 ? route.fulfill({ status: 503, json: { error: "Public detail lookup temporarily failed." } }) : route.fulfill({ json: {
      configured: true, operatorName: "Vectre Pay Inc", contactEmail: "contact@vectrepay.com", publicOrigin: "https://another-public.example",
      aboutUrl: "https://another-public.example/about", termsUrl: "https://another-public.example/terms", privacyUrl: "https://another-public.example/privacy",
    } });
  });
  const dialog = await openXSetup(page);
  await expect(dialog.getByRole("alert").filter({ hasText: "Public detail lookup temporarily failed." })).toBeVisible();
  await dialog.getByRole("button", { name: "Reload X setup URLs", exact: true }).click();
  await expect(dialog.getByLabel("X callback / redirect URL", { exact: true })).toHaveValue("https://another-public.example/api/oauth/x/callback");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
