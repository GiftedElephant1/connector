import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

// Synthetic two-second video used only to test browser preview validation.
// This is not a TikTok review/demo recording and is never sent to TikTok.
const previewFixture = readFileSync(new URL("./fixtures/tiktok-preview.mp4", import.meta.url));
const previewUrl = "https://media.example.test/preview.mp4";
const creator = {
  creator: "Browser test creator", username: "connector_test", privacyOptions: "SELF_ONLY, PUBLIC_TO_EVERYONE",
  maxVideoSeconds: 60, commentsDisabled: true, duetDisabled: false, stitchDisabled: true,
};

async function login(page: Page, connected = true) {
  if (connected) await page.route("**/api/providers", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    for (const provider of data.providers) if (provider.id === "tiktok") provider.connection = {
      provider: "tiktok", status: "connected", accountName: "Browser test creator", accountId: "test-creator", resources: [], lastVerifiedAt: new Date().toISOString(),
    };
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByLabel("Workspace password").fill("connector-browser-test-password");
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your accounts, connected\.|First, make this workspace yours\./ })).toBeVisible();
  if (await page.getByLabel("Choose a password", { exact: true }).isVisible()) {
    await page.getByLabel("Choose a password", { exact: true }).fill("connector-browser-test-password");
    await page.getByLabel("Repeat your password", { exact: true }).fill("connector-browser-test-password");
    await page.getByRole("button", { name: "Save password and continue" }).click();
  }
  await page.getByRole("button", { name: "TikTok publishing", exact: true }).click();
  await expect(page.getByRole("heading", { name: "TikTok publishing." })).toBeVisible();
}

async function preview(page: Page) {
  await page.route(previewUrl, (route) => route.fulfill({ contentType: "video/mp4", body: previewFixture }));
  await page.getByLabel("Video HTTPS URL", { exact: true }).fill(previewUrl);
  await page.getByRole("button", { name: "Preview video", exact: true }).click();
  await expect(page.getByText("Video length: 2 seconds.", { exact: true })).toBeVisible();
}

test("TikTok requires current options, preview and explicit approval; uncertain retries keep the request ID", async ({ page }) => {
  const writes: Record<string, unknown>[] = [];
  const reads: string[] = [];
  await page.route("**/api/actions/tiktok/*", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1)!;
    expect(route.request().headers()["x-connector-request"]).toBe("1");
    if (action === "publish") {
      writes.push(route.request().postDataJSON());
      if (writes.length === 1) return route.fulfill({ status: 502, json: { error: "Submission status is uncertain. Check its saved job." } });
      return route.fulfill({ json: { result: { summary: "TikTok accepted the video submission.", items: [{ publishId: "test-publish-id" }] } } });
    }
    reads.push(action);
    const result = action === "creator-info"
      ? { summary: "Current creator options", items: [creator] }
      : action === "publish-status"
        ? { summary: "TikTok publication status: PUBLISH_COMPLETE.", items: [{ status: "PUBLISH_COMPLETE", reason: "", publishedIds: "12345" }] }
        : { summary: "Available video metrics.", items: [{ id: "12345", title: "Test video", view_count: 12, like_count: 3 }] };
    await route.fulfill({ json: { result } });
  });
  await login(page);
  await expect(page.getByRole("region", { name: "Connected TikTok creator" })).toContainText("@connector_test");
  await expect(page.getByLabel("Who can watch this video?", { exact: true })).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: "Comment", exact: false })).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: "Duet", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "Review video", exact: true })).toBeDisabled();
  await preview(page);
  await page.getByLabel("Caption", { exact: true }).fill("My approved test caption");
  await page.getByLabel("Who can watch this video?", { exact: true }).selectOption("SELF_ONLY");
  await page.getByRole("checkbox", { name: "Duet", exact: true }).check();
  await page.getByRole("checkbox", { name: /I have the rights to publish/ }).check();
  await page.getByRole("button", { name: "Review video", exact: true }).click();
  await expect(page.getByRole("region", { name: "Review TikTok video" })).toContainText("My approved test caption");
  await expect(page.getByLabel("Caption", { exact: true })).toBeDisabled();
  expect(writes).toHaveLength(0);
  await page.getByRole("button", { name: "Publish to TikTok", exact: true }).click();
  await expect(page.locator(".tiktok-error")).toContainText("Submission status is uncertain");
  await page.getByRole("button", { name: "Publish to TikTok", exact: true }).click();
  await expect(page.getByRole("region", { name: "Video submission", exact: true })).toContainText("test-publish-id");
  expect(writes).toHaveLength(2);
  expect(writes[0]).toEqual(writes[1]);
  expect(writes[0]).toMatchObject({ confirmed: true, values: { videoUrl: previewUrl, title: "My approved test caption", privacy: "SELF_ONLY", allowComments: "no", allowDuet: "yes", allowStitch: "no", brandOrganic: "no", brandContent: "no", aiGenerated: "no", consent: "I agree" } });
  expect(writes[0].requestId).toMatch(/^[a-f0-9-]{36}$/);
  await expect(page.getByRole("button", { name: "Publish to TikTok", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Publish ID", { exact: true })).toHaveValue("test-publish-id");
  await page.getByRole("button", { name: "Check publication status", exact: true }).click();
  await expect(page.getByRole("region", { name: "Publication result", exact: true })).toContainText("PUBLISH_COMPLETE");
  await page.getByLabel("Owned public video ID", { exact: true }).fill("12345");
  await page.getByRole("button", { name: "Read video metrics", exact: true }).click();
  await expect(page.getByRole("region", { name: "Video metrics result", exact: true })).toContainText("view_count");
  expect(reads).toEqual(["creator-info", "publish-status", "analytics"]);
});

test("TikTok rejects videos longer than the creator limit and refreshing clears approval", async ({ page }) => {
  await page.route("**/api/actions/tiktok/creator-info", (route) => route.fulfill({ json: { result: { summary: "Options", items: [{ ...creator, maxVideoSeconds: 1 }] } } }));
  await login(page);
  await preview(page);
  await expect(page.getByRole("alert").filter({ hasText: "exceeds TikTok’s 1-second limit" })).toBeVisible();
  await page.getByLabel("Caption", { exact: true }).fill("Too long");
  await page.getByLabel("Who can watch this video?", { exact: true }).selectOption("SELF_ONLY");
  await page.getByRole("checkbox", { name: /I have the rights to publish/ }).check();
  await expect(page.getByRole("button", { name: "Review video", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Refresh publishing options", exact: true }).click();
  await expect(page.getByLabel("Who can watch this video?", { exact: true })).toHaveValue("");
  await expect(page.getByRole("checkbox", { name: /I have the rights to publish/ })).not.toBeChecked();
});

test("TikTok branded declarations invalidate private selection and consent; mobile layout fits", async ({ page }) => {
  await page.route("**/api/actions/tiktok/creator-info", (route) => route.fulfill({ json: { result: { summary: "Options", items: [creator] } } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.getByLabel("Who can watch this video?", { exact: true }).selectOption("SELF_ONLY");
  await page.getByRole("checkbox", { name: /I have the rights to publish/ }).check();
  await page.getByRole("checkbox", { name: /Paid partnership \/ branded content/ }).check();
  await expect(page.getByLabel("Who can watch this video?", { exact: true })).toHaveValue("");
  await expect(page.locator('option[value="SELF_ONLY"]')).toBeDisabled();
  await expect(page.getByRole("checkbox", { name: /I have the rights to publish/ })).not.toBeChecked();
  await expect(page.getByRole("link", { name: "Branded Content Policy", exact: true })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
});

test("TikTok publishing explains missing authorization without making API calls", async ({ page }) => {
  let actionCalls = 0;
  await page.route("**/api/actions/tiktok/*", (route) => { actionCalls++; return route.fulfill({ status: 400, json: { error: "Unexpected request" } }); });
  await login(page, false);
  await expect(page.getByRole("heading", { name: "Connect TikTok first", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview video", exact: true })).toHaveCount(0);
  expect(actionCalls).toBe(0);
});
