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

function card(page: Page, name: string) {
  return page.locator(".provider-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

test("actual connector catalog displays Analytics and Search Console writes and the Plaid bank-data limit", async ({ page }) => {
  // No catalog or action routes are mocked: these badges reflect the server's
  // real registry, including the newly implemented Google write actions.
  await login(page);
  for (const name of ["Google Analytics", "Google Search Console"]) {
    await expect(card(page, name).getByText("Read + write actions", { exact: true })).toBeVisible();
    await expect(card(page, name).getByText("Read-only integration", { exact: true })).toHaveCount(0);
  }
  await expect(card(page, "Plaid").getByText("Read-only integration", { exact: true })).toBeVisible();
  await expect(card(page, "Plaid").getByText("Read + write actions", { exact: true })).toHaveCount(0);
  await expect(card(page, "Plaid")).toContainText(/read-only bank data/i);
});

test("Update permissions starts real Google consent without resetting settings and cancellation preserves the connection display", async ({ page }) => {
  const google = [
    { id: "google-analytics", name: "Google Analytics", scope: "https://www.googleapis.com/auth/analytics.edit" },
    { id: "search-console", name: "Google Search Console", scope: "https://www.googleapis.com/auth/webmasters" },
  ];
  const accountName = "saved-owner@example.test";
  const requests: string[] = [];
  const authorizations: URL[] = [];

  // The existing account summary is a browser fixture, never a real Google
  // token. Application settings, OAuth start/state, and the declined callback
  // use the actual server. Only Google's external consent page is simulated.
  await page.route("**/api/providers", async route => {
    const response = await route.fetch();
    const data = await response.json();
    for (const provider of data.providers) if (google.some(entry => entry.id === provider.id)) {
      provider.connection = {
        provider: provider.id, status: "connected", accountName, accountId: "saved-google-owner",
        resources: [], lastVerifiedAt: "2026-10-14T00:00:00.000Z",
      };
    }
    await route.fulfill({ response, json: data });
  });
  await page.route("https://accounts.google.com/**", async route => {
    const authorization = new URL(route.request().url());
    authorizations.push(authorization);
    const callback = new URL(authorization.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorization.searchParams.get("state")!);
    callback.searchParams.set("error", "access_denied");
    await route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><title>Simulated Google consent</title><h1>Review additional permissions</h1><a href="${callback.href.replaceAll("&", "&amp;")}">Cancel consent</a>`,
    });
  });

  await login(page);
  const saved = await page.request.put("/api/settings", {
    headers: { "x-connector-request": "1" },
    data: { values: { GOOGLE_CLIENT_ID: "browser-permissions.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "browser-permissions-private-secret" } },
  });
  expect(saved.ok()).toBe(true);
  const before = await (await page.request.get("/api/settings/providers/google-analytics")).json();
  await page.reload();
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      requests.push(`${request.method()} ${url.pathname}`);
    }
  });

  for (const [index, provider] of google.entries()) {
    await page.getByLabel("Search platforms").fill(provider.name);
    await card(page, provider.name).getByRole("button", { name: "View connection", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText(accountName);
    await page.getByRole("dialog").getByRole("button", { name: "Update permissions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Review additional permissions", exact: true })).toBeVisible();

    expect(authorizations).toHaveLength(index + 1);
    const authorization = authorizations[index];
    expect(authorization.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorization.searchParams.get("client_id")).toBe("browser-permissions.apps.googleusercontent.com");
    expect(authorization.searchParams.get("scope")!.split(" ")).toContain(provider.scope);
    expect(authorization.searchParams.get("prompt")).toBe("consent select_account");
    expect(authorization.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorization.searchParams.has("client_secret")).toBe(false);

    await page.getByRole("link", { name: "Cancel consent", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Your accounts, connected.", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Authorization was declined");
    await expect(card(page, provider.name)).toContainText(accountName);
    await expect(card(page, provider.name).getByRole("button", { name: "View connection", exact: true })).toBeVisible();
    await expect(card(page, provider.name).getByText("Connected", { exact: true })).toBeVisible();
    const after = await (await page.request.get("/api/settings/providers/google-analytics")).json();
    expect(after).toEqual(before);
  }

  expect(requests).toEqual(google.map(provider => `POST /api/oauth/${provider.id}/start`));
});
