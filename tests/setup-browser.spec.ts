import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page
    .getByLabel("Workspace password")
    .fill("connector-browser-test-password");
  await page
    .getByRole("button", { name: "Open workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", {
      name: /Your accounts, connected\.|First, make this workspace yours\./,
    }),
  ).toBeVisible();
  if (await page.getByLabel("Choose a password", { exact: true }).isVisible()) {
    await page
      .getByLabel("Choose a password", { exact: true })
      .fill("connector-browser-test-password");
    await page
      .getByLabel("Repeat your password", { exact: true })
      .fill("connector-browser-test-password");
    await page
      .getByRole("button", { name: "Save password and continue" })
      .click();
  }
  await expect(
    page.getByRole("heading", { name: "Your accounts, connected." }),
  ).toBeVisible();
}

test("guided provider setup saves credentials on real server, masks secrets after reload, and needs no restart", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("link", { name: "Open ngrok’s Your Authtoken page ↗" }),
  ).toHaveAttribute(
    "href",
    "https://dashboard.ngrok.com/get-started/your-authtoken",
  );
  const discord = page
    .locator(".settings-providers > div")
    .filter({ hasText: "Discord" });
  await discord.getByRole("button", { name: "Manage setup" }).click();
  await expect(
    page.getByLabel("Redirect address", { exact: true }),
  ).toHaveValue(/\/api\/oauth\/discord\/callback$/);
  await page
    .getByLabel(/Discord client ID/)
    .fill("browser-client-id");
  await page
    .getByLabel(/Discord client secret/)
    .fill("browser-private-client-secret");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(discord).toContainText("Application ready");
  const response = await page.request.get("/api/settings");
  expect(response.ok()).toBe(true);
  expect(await response.text()).not.toContain("browser-private-client-secret");
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await discord.getByRole("button", { name: "Manage setup" }).click();
  await expect(page.getByLabel(/Discord client ID/)).toHaveValue(
    "browser-client-id",
  );
  await expect(page.getByLabel(/Discord client secret/)).toHaveValue("");
  await expect(page.getByLabel(/Discord client secret/)).toHaveAttribute(
    "placeholder",
    "Already saved — leave blank to keep",
  );
});

test("ngrok placeholder errors guide the user back to the actual dashboard token", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("ngrok authentication token").fill("ngrok config add-authtoken $YOUR_AUTHTOKEN");
  await page.getByRole("button", { name: "Start public access", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("placeholder or a hidden token");
  await expect(page.getByRole("alert")).toContainText("click the copy icon beside your actual token");
  await expect(page.getByLabel("ngrok authentication token")).toHaveAttribute("type", "password");
  await expect(page.getByRole("button", { name: "Start public access", exact: true })).toBeEnabled();
});

test("advanced Connector key can be copied and remains masked by default", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.getByRole("button", { name: "AI connections", exact: true }).click();
  await page.getByText("Advanced: connect with a Connector API key", { exact: true }).click();
  await page.getByRole("button", { name: "Show Connector API key" }).click();
  await expect(
    page.getByLabel("Connector API key", { exact: true }),
  ).toHaveAttribute("type", "password");
  await page
    .getByRole("button", { name: "Copy Connector URL", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "http://127.0.0.1:4173/mcp",
  );
  await page
    .getByRole("button", { name: "Copy Connector API key", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "connector-browser-test-pipeline-key",
  );
  await page.getByRole("button", { name: /Claude Set up connection/ }).click();
  await expect(
    page.getByRole("heading", { name: "Add Connector in Claude" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide Connector API key" }).click();
  await expect(
    page.getByLabel("Connector API key", { exact: true }),
  ).toHaveCount(0);
});

test("desktop handoff clears its URL capability before exchange and retains an existing valid session", async ({
  page,
}) => {
  await login(page);
  let fragmentAtExchange = "not-called";
  await page.route("**/api/desktop/unlock", async (route) => {
    fragmentAtExchange = await page.evaluate(() => window.location.hash);
    expect(route.request().postDataJSON()).toEqual({
      token: "used-desktop-capability",
    });
    await route.fulfill({
      status: 401,
      json: { error: "This desktop link has already been used." },
    });
  });
  await page.goto("about:blank");
  await page.goto("/#desktopToken=used-desktop-capability");
  await expect(
    page.getByRole("heading", { name: "Your accounts, connected." }),
  ).toBeVisible();
  expect(fragmentAtExchange).toBe("");
  expect(new URL(page.url()).hash).toBe("");
});

test("WhatsApp business setup remains available and removed Plaid setup is absent", async ({
  page,
}) => {
  await login(page);
  await page.getByLabel("Search platforms").fill("WhatsApp");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "WhatsApp Business Cloud API",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "Personal WhatsApp accounts",
  );
  await page.keyboard.press("Escape");
  await page.getByLabel("Search platforms").fill("Plaid");
  await expect(page.locator(".provider-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.locator(".settings-providers");
  await expect(settings).not.toContainText("Plaid");
  await expect(settings).toContainText("Discord");
  await expect(settings).toContainText("LinkedIn");
});

test("updates show the installed version and prepare a local connector request without changing saved settings", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  const settingsBefore = await (await page.request.get("/api/settings")).json();
  const installation = await (await page.request.get("/api/installation")).json();
  const writes: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const updates = page.getByRole("region", { name: "Updates and new connectors" });
  await expect(updates).toContainText(`Installed version ${installation.version}`);
  await expect(
    updates.getByRole("link", { name: "View Windows releases ↗" }),
  ).toHaveAttribute(
    "href",
    "https://github.com/GiftedElephant1/connector/releases",
  );
  await expect(updates.getByRole("link", { name: "Open update guide ↗" })).toHaveAttribute(
    "href",
    installation.updateGuideUrl,
  );
  await expect(updates).toContainText("Update Connector.vbs");
  await expect(updates).toContainText("existing Connector folder");
  await expect(updates).toContainText("Reopen your original installation");
  await updates.getByText("Request another connector", { exact: true }).click();
  await expect(updates.getByRole("button", { name: "Prepare connector request" })).toBeDisabled();
  await updates.getByLabel("Platform name", { exact: true }).fill("Slack");
  await updates.getByLabel("What should the connector do?").fill("Send messages and read replies.");
  await updates.getByRole("button", { name: "Prepare connector request" }).click();
  const draft = updates.getByLabel("Your connector request", { exact: true });
  await expect(draft).toHaveValue(/official API connector for Slack/);
  await expect(draft).toHaveValue(/Send messages and read replies\./);
  await expect(draft).toHaveValue(/preserve my existing connected accounts/);
  await expect(draft).toHaveAttribute("readonly", "");
  await updates.getByRole("button", { name: "Copy connector request" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await draft.inputValue());
  await expect(updates.getByRole("status")).toHaveText("Copied. Paste this into your Codex chat.");
  await updates.getByLabel("Platform name", { exact: true }).fill("Bluesky");
  await expect(draft).toHaveCount(0);
  expect(writes).toEqual([]);
  const settingsAfter = await (await page.request.get("/api/settings")).json();
  expect(settingsAfter).toEqual(settingsBefore);
});

test("installation details can be retried while connector requests remain available", async ({ page }) => {
  await login(page);
  let fail = true;
  await page.route("**/api/installation", (route) => {
    if (fail) {
      fail = false;
      return route.fulfill({ status: 503, json: { error: "Installation details are temporarily unavailable." } });
    }
    return route.continue();
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const updates = page.getByRole("region", { name: "Updates and new connectors" });
  await expect(updates.getByRole("alert")).toHaveText("Installation details are temporarily unavailable.");
  await expect(updates.getByText("Request another connector", { exact: true })).toBeVisible();
  await updates.getByRole("button", { name: "Retry installation details" }).click();
  await expect(updates.getByRole("link", { name: "View Windows releases ↗" })).toBeVisible();
  await expect(updates.getByRole("alert")).toHaveCount(0);
});
