import { expect, test, type Page } from "@playwright/test";

const password = "connector-browser-test-password";

async function signIn(page: Page) {
  await page.getByLabel("Workspace password").fill(password);
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your accounts, connected\.|First, make this workspace yours\./ })).toBeVisible();
  if (await page.getByLabel("Choose a password", { exact: true }).isVisible()) {
    await page.getByLabel("Choose a password", { exact: true }).fill(password);
    await page.getByLabel("Repeat your password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Save password and continue" }).click();
  }
  await expect(page.getByRole("heading", { name: "Your accounts, connected." })).toBeVisible();
}

async function rejectedLinkedInCallback(page: Page) {
  await page.goto("/");
  await signIn(page);
  const saved = await page.request.put("/api/settings", {
    headers: { "x-connector-request": "1" },
    data: { values: {
      APP_ORIGIN: new URL(page.url()).origin,
      LINKEDIN_CLIENT_ID: "oauth-feedback-fixture-app",
      LINKEDIN_CLIENT_SECRET: "oauth-feedback-fixture-secret",
      LINKEDIN_ENABLE_MEMBER_READ: "false",
    } },
  });
  expect(saved.ok()).toBe(true);
  const started = await page.request.post("/api/oauth/linkedin/start", {
    headers: { "x-connector-request": "1" },
  });
  expect(started.ok()).toBe(true);
  const authorization = new URL((await started.json()).url);
  expect(authorization.hostname).toBe("www.linkedin.com");
  expect(authorization.searchParams.get("scope")?.split(" ")).toEqual(["openid", "profile", "w_member_social"]);
  const callback = new URL(authorization.searchParams.get("redirect_uri")!);
  expect(callback.origin).toBe(new URL(page.url()).origin);
  expect(callback.pathname).toBe("/api/oauth/linkedin/callback");
  callback.searchParams.set("state", authorization.searchParams.get("state")!);
  callback.searchParams.set("error", "unauthorized_scope_error");
  // Provider text is untrusted and must not be reflected into the dashboard.
  callback.searchParams.set("error_description", "private-provider-debug-value");
  return callback.href;
}

async function expectScopeError(page: Page) {
  const alert = page.getByRole("alert").filter({ hasText: "LinkedIn rejected the requested permissions." });
  await expect(alert).toBeVisible();
  await expect(alert).toContainText("Sign In with LinkedIn using OpenID Connect");
  await expect(alert).toContainText("openid and profile");
  await expect(alert).toContainText("Check LinkedIn setup");
  await expect(page.locator("body")).not.toContainText("private-provider-debug-value");
  await expect(page.getByText("Account connected. Your connection is ready.", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/$/);
  await page.getByLabel("Search platforms").fill("LinkedIn");
  const member = page.locator(".provider-card").filter({ has: page.getByRole("heading", { name: "LinkedIn", exact: true }) });
  await expect(member.getByRole("button", { name: "Connect account", exact: true })).toBeVisible();
}

test("a real LinkedIn callback rejection stays visible after the dashboard loads", async ({ page }) => {
  const callback = await rejectedLinkedInCallback(page);
  // Use the real state-bound callback; no request is made to LinkedIn or its token endpoint.
  await page.goto(callback);
  await expectScopeError(page);
  await page.getByRole("button", { name: "Dismiss notification", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "LinkedIn rejected the requested permissions." })).toHaveCount(0);
});

test("LinkedIn callback feedback survives signing in again before the dashboard opens", async ({ page, context }) => {
  const callback = await rejectedLinkedInCallback(page);
  const response = await page.request.get(callback, { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  const destination = response.headers().location;
  expect(destination).toMatch(/^\/\?error=/);
  // The callback was authenticated; simulate the browser session ending before its
  // redirect reaches the dashboard. The reason must survive the password screen.
  await context.clearCookies();
  await page.goto(destination);
  await expect(page.getByRole("heading", { name: "Welcome to Connector" })).toBeVisible();
  await expect(page).toHaveURL(/\?error=/);
  await signIn(page);
  await expectScopeError(page);
});
