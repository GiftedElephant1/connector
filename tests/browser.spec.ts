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
  await expect(page.locator(".provider-card")).toHaveCount(25);
}

test("real login, full provider catalog, filters, setup callback and logout work", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await login(page);
  await page.screenshot({ path: "test-results/desktop-dashboard.png" });
  await page.getByRole("button", { name: "Analytics", exact: true }).click();
  await expect(page.locator(".provider-card")).toHaveCount(2);
  await page.getByRole("button", { name: /All platforms/ }).click();
  await page.getByLabel("Search platforms").fill("Instagram");
  const instagram = page.locator(".provider-card").filter({
    has: page.getByRole("heading", { name: "Instagram", exact: true }),
  });
  await instagram.getByRole("button", { name: "Connect account" }).click();
  await expect(page.getByRole("dialog")).toContainText("Meta app ID");
  await expect(
    page.getByLabel("Redirect address", { exact: true }),
  ).toHaveValue(/\/api\/oauth\/instagram\/callback$/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(
    page.getByRole("heading", { name: "Welcome to Connector" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("credential dialogs mask and discard input and require X Ads companion credentials", async ({
  page,
}) => {
  await login(page);
  await page.getByLabel("Search platforms").fill("OpenAI");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  const input = page.getByLabel("API key", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.fill("browser-fixture-secret");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await page.keyboard.press("Escape");
  await page.getByLabel("Search platforms").fill("X Business");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  for (const label of [
    "App consumer key",
    "App consumer secret",
    "User access token secret",
  ]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    await expect(page.getByLabel(label, { exact: true })).toHaveAttribute(
      "required",
      "",
    );
  }
});

test("verification failure stays visible without claiming connection success", async ({
  page,
}) => {
  await login(page);
  await page.route("**/api/connections/openai/api-key", (route) =>
    route.fulfill({
      status: 422,
      json: {
        error:
          "OpenAI rejected this credential. Reconnect with a valid credential.",
      },
    }),
  );
  await page.getByLabel("Search platforms").fill("OpenAI");
  await page
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await page
    .getByLabel("API key", { exact: true })
    .fill("browser-fixture-invalid-key");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Connect account", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText(
    "OpenAI rejected this credential",
  );
  await expect(page.locator(".provider-card")).toContainText("Not connected");
});

test("mobile dashboard fits viewport and supports category navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Advertising", exact: true }).click();
  await expect(page.locator(".provider-card")).toHaveCount(7);
  await page.screenshot({
    path: "test-results/mobile-dashboard.png",
    fullPage: true,
  });
});

test("pipeline explains the direct Grok connector and schedule shows actual empty state", async ({
  page,
}) => {
  await login(page);
  await page.getByRole("button", { name: "Pipeline", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Add your connector in Grok" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Show connection details" }).click();
  await expect(page.getByLabel("Connector URL", { exact: true })).toHaveValue(
    /\/mcp$/,
  );
  await expect(
    page.getByLabel("Connector API key", { exact: true }),
  ).toHaveAttribute("type", "password");
  await expect(page.locator("main")).toContainText("Streamable HTTP");
  await page.screenshot({ path: "test-results/pipeline-dashboard.png" });
  await page.getByRole("button", { name: "Scheduled jobs →" }).click();
  await expect(page.locator("main")).toContainText("Ask your bot to schedule");
  await expect(page.locator(".job-card")).toHaveCount(0);
});
