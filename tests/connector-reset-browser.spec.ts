import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

async function card(page: Page, name: string) {
  await page.getByLabel("Search platforms").fill(name);
  return page.locator(".provider-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

test("LinkedIn reset confirms shared impact, cancellation preserves settings, and setup starts with blank credentials", async ({ page }) => {
  await login(page);
  const saved = await page.request.put("/api/settings", {
    headers: { "x-connector-request": "1" },
    data: { values: { LINKEDIN_CLIENT_ID: "mistyped-linkedin-app", LINKEDIN_CLIENT_SECRET: "mistyped-linkedin-secret", DISCORD_CLIENT_ID: "keep-discord-app", DISCORD_CLIENT_SECRET: "keep-discord-secret" } },
  });
  expect(saved.ok()).toBe(true);
  await page.reload();
  let resets = 0;
  page.on("request", request => { if (request.url().endsWith("/linkedin/reset") && request.method() === "POST") resets++; });
  const linkedin = await card(page, "LinkedIn");
  await linkedin.getByRole("button", { name: "Check LinkedIn setup" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Disable and reset", exact: true }).click();
  let dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("listitem").filter({ hasText: /^LinkedIn Campaign Manager$/ })).toBeVisible();
  await expect(dialog.getByText("These connectors share application settings and will all be reset:", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(resets).toBe(0);
  const before = await (await page.request.get("/api/settings/providers/linkedin")).json();
  expect(before.fields.find((field: { key: string }) => field.key === "LINKEDIN_CLIENT_ID").value).toBe("mistyped-linkedin-app");
  await linkedin.getByRole("button", { name: "Disable and reset", exact: true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Disable and reset", exact: true }).click();
  await expect(dialog.getByText(/Reset complete\. LinkedIn is disabled/)).toBeVisible();
  expect(resets).toBe(1);
  const state = await (await page.request.get("/api/providers")).json();
  for (const id of ["linkedin", "linkedin-ads"]) expect(state.providers.find((provider: { id: string }) => provider.id === id).configured).toBe(false);
  expect(state.providers.find((provider: { id: string }) => provider.id === "discord").configured).toBe(true);
  await dialog.getByRole("button", { name: "Set up again", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Set up LinkedIn", exact: true })).toBeVisible();
  await expect(page.getByLabel("LinkedIn client ID", { exact: true })).toHaveValue("");
  await expect(page.getByLabel("LinkedIn client secret", { exact: true })).toHaveValue("");
  await expect(page.getByPlaceholder("Already saved — leave blank to keep")).toHaveCount(0);
});

test("API key connector reset is accessible before a successful connection and reopens an empty credential form", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 850 });
  await login(page);
  const mailchimp = await card(page, "Mailchimp");
  await mailchimp.getByRole("button", { name: "Connect account", exact: true }).click();
  await page.getByLabel("API key", { exact: true }).fill("mistyped-secret-never-submitted");
  await page.getByRole("dialog").getByRole("button", { name: "Disable and reset", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("listitem").filter({ hasText: /^Mailchimp$/ })).toBeVisible();
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Disable and reset", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog.getByText(/Reset complete\. Mailchimp is disabled/)).toBeVisible();
  await dialog.getByRole("button", { name: "Set up again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Connect Mailchimp", exact: true })).toBeVisible();
  await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Connect account", exact: true })).toBeDisabled();
});

test("resetting an actual Obsidian connection disables vault access while keeping notes intact", async ({ page }) => {
  const vault = mkdtempSync(join(tmpdir(), "connector-reset-vault-"));
  const note = join(vault, "Keep my note.md");
  writeFileSync(note, "# Keep this note\n");
  try {
    await login(page);
    const obsidian = await card(page, "Obsidian");
    await obsidian.getByRole("button", { name: "Connect account", exact: true }).click();
    await page.getByLabel("Full path to your Obsidian vault folder").fill(vault);
    await page.getByRole("dialog").getByRole("button", { name: "Connect account", exact: true }).click();
    await expect(obsidian.getByRole("button", { name: "View connection" })).toBeVisible();
    await obsidian.getByRole("button", { name: "Disable and reset", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("local Obsidian notes");
    await dialog.getByRole("button", { name: "Disable and reset", exact: true }).click();
    await expect(dialog.getByText(/Reset complete\. Obsidian is disabled/)).toBeVisible();
    const state = await (await page.request.get("/api/providers")).json();
    expect(state.providers.find((provider: { id: string }) => provider.id === "obsidian").connection).toBeNull();
    expect(readFileSync(note, "utf8")).toBe("# Keep this note\n");
    await dialog.getByRole("button", { name: "Set up again", exact: true }).click();
    await expect(page.getByLabel("Full path to your Obsidian vault folder")).toHaveValue("");
  } finally { rmSync(vault, { recursive: true, force: true }); }
});
