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
    .getByLabel("Discord client ID", { exact: true })
    .fill("browser-client-id");
  await page
    .getByLabel("Discord client secret", { exact: true })
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

test("authenticated agent details can be copied without exposing the key by default", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await login(page);
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  await page.getByRole("button", { name: "Show connection details" }).click();
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
  await page.getByRole("button", { name: "Claude", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Add your connector in Claude" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Hide connection details" }).click();
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

test("WhatsApp explains business setup and Plaid opens the secure picker then exchanges its token", async ({
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
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "Sandbox connects test banks",
  );
  await expect(page.getByRole("dialog")).toContainText(
    "AI assistants you authorize",
  );
  await page
    .getByLabel("Plaid client ID", { exact: true })
    .fill("browser-plaid-id");
  await page
    .getByLabel("Plaid secret", { exact: true })
    .fill("browser-plaid-secret");
  // The external Plaid UI and Plaid network responses are mocked; settings use the real server.
  await page.evaluate(() => {
    (window as unknown as { Plaid: unknown }).Plaid = {
      create: (options: {
        token: string;
        onSuccess: (token: string) => void;
      }) => ({
        open: () => {
          if (options.token !== "link-sandbox-browser")
            throw new Error("Unexpected Link token");
          options.onSuccess("public-sandbox-browser");
        },
        destroy: () => {},
      }),
    };
  });
  await page.route("**/api/plaid/link-token", (route) =>
    route.fulfill({
      json: {
        linkToken: "link-sandbox-browser",
        flowId: "browser-link-flow",
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        environment: "sandbox",
      },
    }),
  );
  let exchanged = false;
  await page.route("**/api/plaid/exchange", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      publicToken: "public-sandbox-browser",
      flowId: "browser-link-flow",
    });
    exchanged = true;
    return route.fulfill({ json: { connection: {} } });
  });
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({ hasText: "Bank connected." }),
  ).toBeVisible();
  expect(exchanged).toBe(true);
  expect(
    await page.evaluate(() => sessionStorage.getItem("connector-plaid-link")),
  ).toBeNull();
});
