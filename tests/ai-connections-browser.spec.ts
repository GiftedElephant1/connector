import { expect, test, type Page } from "@playwright/test";

const password = "connector-browser-test-password";
const url = "https://connector.example/mcp";
const authorization = {
  id: "browser-consent", clientName: "Claude <unverified>",
  redirectUri: "https://client.example/return", scope: "connector", resource: url,
  expiresAt: new Date(Date.now() + 600000).toISOString(),
  workspaceProfiles: [
    { id: "profile-personal", name: "Personal assistant", bindings: [{ accountId: "account-personal", accountEmail: "personal@example.com", apps: ["docs", "gmail"] }], defaultAccountId: "account-personal" },
    { id: "profile-work", name: "Work assistant", bindings: [{ accountId: "account-work", accountEmail: "work@example.com", apps: ["sheets", "drive"] }] },
  ],
};
async function login(page: Page, path = "/") {
  await page.goto(path);
  await page.getByLabel("Workspace password").fill(password);
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your accounts, connected\.|First, make this workspace yours\.|Authorize an AI connection/ })).toBeVisible();
  if (await page.getByLabel("Choose a password", { exact: true }).isVisible()) {
    await page.getByLabel("Choose a password", { exact: true }).fill(password);
    await page.getByLabel("Repeat your password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Save password and continue" }).click();
  }
}

test("AI apps use subscription instructions, expose no developer key prompt, and never claim an opened app is connected", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/ai/connectors", (route) => route.fulfill({ json: { url, grants: [] } }));
  await page.route("https://claude.ai/**", (route) => route.fulfill({ contentType: "text/html", body: "Claude setup placeholder" }));
  await login(page);
  await expect(page.locator(".provider-card")).toHaveCount(25);
  await expect(page.locator(".provider-card").filter({ hasText: "Anthropic" })).toHaveCount(0);
  await page.getByRole("button", { name: "Use Claude, ChatGPT, or Grok" }).click();
  await expect(page.getByLabel("Connector URL", { exact: true })).toHaveValue(url);
  await expect(page.getByRole("region", { name: "AI app connections" })).toContainText("do not need an Anthropic, OpenAI, or xAI developer API key");
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Connector API key", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Copy Connector URL", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open Claude ↗" }).click();
  const popup = await popupPromise;
  await popup.close();
  await expect(page.locator(".ai-grants")).toContainText("No AI app has been approved yet");
  await page.getByRole("button", { name: /ChatGPT Set up connection/ }).click();
  await expect(page.getByRole("heading", { name: "Add Connector in ChatGPT" })).toBeVisible();
  await expect(page.locator(".ai-setup-steps")).toContainText("does not require an OpenAI API account");
  await page.getByRole("button", { name: /Grok Set up connection/ }).click();
  await expect(page.locator(".ai-setup-steps")).toContainText("Requires a Grok client with custom remote MCP support");
});

test("authorization survives password sign-in, starts with no access, and approves only the selected Google profile", async ({ page }) => {
  const writes: unknown[] = [];
  await page.route("**/api/ai/authorize/browser-consent", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: authorization });
    expect(route.request().headers()["x-connector-request"]).toBe("1");
    writes.push(route.request().postDataJSON());
    return route.fulfill({ json: { redirectUrl: "https://client.example/return?code=opaque-code&state=preserved" } });
  });
  await page.route("https://client.example/**", (route) => route.fulfill({ contentType: "text/html", body: "Returned to AI app" }));
  await login(page, "/?authorize=browser-consent");
  await expect(page.getByRole("heading", { name: "Authorize an AI connection" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("authorize")).toBe("browser-consent");
  await expect(page.locator(".ai-authorization")).toContainText("Claude <unverified>");
  await expect(page.locator(".ai-request-details")).toContainText("https://client.example/return");
  await expect(page.getByRole("checkbox", { name: /Standard platform tools/ })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Approve selected access" })).toBeDisabled();
  expect(writes).toEqual([]);
  await page.getByLabel("Google Workspace agent profile", { exact: true }).selectOption("profile-work");
  await expect(page.locator(".ai-profile-summary")).toContainText("work@example.com");
  await expect(page.locator(".ai-profile-summary")).toContainText("sheets, drive");
  await expect(page.locator(".ai-profile-summary")).not.toContainText("personal@example.com");
  await page.getByRole("button", { name: "Approve selected access" }).click();
  await expect(page).toHaveURL("https://client.example/return?code=opaque-code&state=preserved");
  expect(writes).toEqual([{ approve: true, platforms: false, workspaceProfileId: "profile-work" }]);
});

test("deny returns to the registered AI app without authorizing selected accounts", async ({ page }) => {
  let response: unknown;
  await page.route("**/api/ai/authorize/browser-consent", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: authorization });
    response = route.request().postDataJSON();
    return route.fulfill({ json: { redirectUrl: "https://client.example/return?error=access_denied" } });
  });
  await page.route("https://client.example/**", (route) => route.fulfill({ contentType: "text/html", body: "Denied" }));
  await login(page, "/?authorize=browser-consent");
  await page.getByRole("checkbox", { name: /Standard platform tools/ }).check();
  await page.getByLabel("Google Workspace agent profile", { exact: true }).selectOption("profile-work");
  await page.getByRole("button", { name: "Deny access" }).click();
  await expect(page).toHaveURL("https://client.example/return?error=access_denied");
  expect(response).toEqual({ approve: false, platforms: false });
});

test("expired requests remain unapproved and allow returning to AI setup", async ({ page }) => {
  let writes = 0;
  await page.route("**/api/ai/authorize/expired", (route) => {
    if (route.request().method() !== "GET") writes++;
    return route.fulfill({ status: 400, json: { error: "This authorization request has expired. Restart from your AI app." } });
  });
  await page.route("**/api/ai/connectors", (route) => route.fulfill({ json: { url, grants: [] } }));
  await login(page, "/?authorize=expired");
  await expect(page.getByRole("alert")).toContainText("has expired");
  await expect(page.getByRole("button", { name: "Approve selected access" })).toHaveCount(0);
  await page.getByRole("button", { name: "Return to Connector without approving" }).click();
  await expect(page.getByRole("heading", { name: "Connect your AI apps." })).toBeVisible();
  expect(new URL(page.url()).search).toBe("");
  expect(writes).toBe(0);
});

test("approved connections can be revoked without disconnecting accounts, and AI pages fit mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  let revoked = false;
  let lastUsedAt: string | undefined;
  const writes: string[] = [];
  await page.route("**/api/ai/connectors", (route) => route.fulfill({ json: { url, grants: revoked ? [] : [{ id: "grant-one", clientName: "My AI app", createdAt: "2026-10-14T00:00:00.000Z", platforms: true, workspaceProfileId: "profile-work", workspaceProfileName: "Work assistant", lastUsedAt }] } }));
  await page.route("**/api/ai/connectors/grant-one", (route) => {
    expect(route.request().method()).toBe("DELETE");
    expect(route.request().headers()["x-connector-request"]).toBe("1");
    revoked = true;
    return route.fulfill({ json: { ok: true } });
  });
  await login(page);
  page.on("request", (request) => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(new URL(request.url()).pathname); });
  await page.getByRole("button", { name: "AI connections", exact: true }).click();
  await expect(page.locator(".ai-grant")).toContainText("Work assistant");
  await expect(page.locator(".ai-grant")).toContainText("waiting for the first successful tool call");
  lastUsedAt = "2026-10-14T00:05:00.000Z";
  await page.getByRole("button", { name: "Refresh AI connections" }).click();
  await expect(page.locator(".ai-grant")).toContainText("Last successful tool call:");
  await expect(page.locator(".ai-grant")).not.toContainText("waiting for the first successful tool call");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Revoke access for My AI app" }).click();
  expect(revoked).toBe(false);
  await page.getByRole("button", { name: "Keep access" }).click();
  expect(revoked).toBe(false);
  await page.getByRole("button", { name: "Revoke access for My AI app" }).click();
  await page.getByRole("button", { name: "Confirm revoke access" }).click();
  await expect(page.locator(".ai-grants")).toContainText("No AI app has been approved yet");
  await expect(page.getByRole("status").filter({ hasText: "Access revoked" })).toContainText("platform accounts remain connected");
  expect(writes).toEqual(["/api/ai/connectors/grant-one"]);
  await page.route("**/api/ai/authorize/browser-consent", (route) => route.fulfill({ json: { ...authorization, redirectUri: "https://long-client-return.example/" + "callback-path-".repeat(25) } }));
  await page.goto("/?authorize=browser-consent");
  await page.getByLabel("Google Workspace agent profile", { exact: true }).selectOption("profile-personal");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/ai-consent-mobile.png", fullPage: true });
});

test("AI reset previews the exact registration, handles unfinished setup, and preserves another registration with the same name", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const first = { id: "client-failed", name: "My AI app", redirectUris: ["https://first.example/" + "callback-path-".repeat(15)], grants: 0, pendingRequests: 1 };
  const other = { id: "client-other", name: "My AI app", redirectUris: ["https://other.example/callback"], grants: 1, pendingRequests: 0 };
  let reset = false;
  const writes: unknown[] = [];
  await page.route("**/api/ai/connectors", route => route.fulfill({ json: { url, grants: [], clients: reset ? [other] : [first, other] } }));
  await page.route("**/api/ai/clients/client-failed/reset", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { ...first, authorizationCodes: 0, accessTokens: 0, refreshTokens: 0 } });
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-connector-request"]).toBe("1");
    writes.push(route.request().postDataJSON());
    reset = true;
    return route.fulfill({ json: { ok: true } });
  });
  await login(page);
  await page.getByRole("button", { name: "AI connections", exact: true }).click();
  const failed = page.locator(".ai-client").filter({ hasText: "client-failed" });
  await expect(failed).toContainText("0 approved connection(s)");
  await failed.getByRole("button", { name: "Disable and reset My AI app" }).click();
  const preview = page.getByRole("group", { name: "Confirm AI connection reset" });
  await expect(preview).toContainText("1 pending request(s)");
  await expect(preview).toContainText("Jobs already queued will still run");
  await expect(preview).toContainText("remove Connector in this AI app’s connector settings");
  await expect(preview).toContainText("client-failed");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(writes).toEqual([]);
  await preview.getByRole("button", { name: "Keep AI connection" }).click();
  await failed.getByRole("button", { name: "Disable and reset My AI app" }).click();
  await preview.getByRole("button", { name: "Confirm disable and reset AI connection" }).click();
  await expect(page.locator(".ai-client")).toHaveCount(1);
  await expect(page.locator(".ai-client")).toContainText("client-other");
  await expect(page.getByRole("status").filter({ hasText: "disabled and reset" })).toContainText("Remove Connector in that AI app’s connector settings");
  expect(writes).toEqual([{ confirmed: true }]);
});

test("shared AI key reset explains every affected client and hides the previous key until explicitly revealed again", async ({ page }) => {
  let reset = false;
  const writes: unknown[] = [];
  await page.route("**/api/ai/connectors", route => route.fulfill({ json: { url, grants: [], clients: [] } }));
  await page.route("**/api/settings/pipeline-key", route => route.fulfill({ json: { apiKey: reset ? "new-shared-key" : "old-shared-key", url, transport: "Streamable HTTP" } }));
  await page.route("**/api/settings/pipeline-key/reset", route => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-connector-request"]).toBe("1");
    writes.push(route.request().postDataJSON());
    reset = true;
    return route.fulfill({ json: { apiKey: "new-shared-key", url, transport: "Streamable HTTP" } });
  });
  await login(page);
  await page.getByRole("button", { name: "AI connections", exact: true }).click();
  await page.getByText("Advanced: connect with a Connector API key", { exact: true }).click();
  await page.getByRole("button", { name: "Show Connector API key" }).click();
  await expect(page.getByLabel("Connector API key", { exact: true })).toHaveValue("old-shared-key");
  await page.getByRole("button", { name: "Disable and reset shared API key", exact: true }).click();
  const preview = page.getByRole("group", { name: "Confirm shared API key reset" });
  await expect(preview).toContainText("Every AI client using the old key loses access");
  await expect(preview).toContainText("Jobs already queued will still run");
  expect(writes).toEqual([]);
  await preview.getByRole("button", { name: "Keep shared API key" }).click();
  await page.getByRole("button", { name: "Disable and reset shared API key", exact: true }).click();
  await preview.getByRole("button", { name: "Confirm disable and reset shared API key" }).click();
  await expect(page.getByLabel("Connector API key", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("status").filter({ hasText: "previous shared" })).toContainText("replace the old key in each AI app");
  await page.getByRole("button", { name: "Show Connector API key" }).click();
  await expect(page.getByLabel("Connector API key", { exact: true })).toHaveValue("new-shared-key");
  expect(writes).toEqual([{ confirmed: true }]);
});
