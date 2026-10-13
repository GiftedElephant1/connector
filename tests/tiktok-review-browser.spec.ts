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

async function openReview(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Prepare TikTok submission" }).click();
  await expect(page.getByLabel("App operator name")).toBeVisible();
}

test("TikTok review publishes real operator details and withholds localhost submission URLs", async ({ page }) => {
  await login(page);
  await openReview(page);
  await page.getByLabel("App operator name").fill("Connector review test operator");
  await page.getByLabel("Public contact email").fill("review@example.com");
  await page.getByRole("button", { name: "Save public page details", exact: true }).click();
  await expect(page.getByText("Public page details saved. Preview the pages before submitting them.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy Terms of Service URL", exact: true })).toHaveCount(0);
  await expect(page.getByText("Start public access above before copying submission URLs.", { exact: false })).toBeVisible();
  const terms = await page.request.get("/terms");
  expect(terms.status()).toBe(200);
  expect(await terms.text()).toContain("Connector review test operator");
  const privacy = await page.request.get("/privacy");
  expect(privacy.status()).toBe(200);
  expect(await privacy.text()).toContain("review@example.com");
  await page.reload();
  await openReview(page);
  await expect(page.getByLabel("App operator name")).toHaveValue("Connector review test operator");
  await expect(page.getByLabel("Public contact email")).toHaveValue("review@example.com");
});

test("TikTok review copies public domain URLs and exact scope explanation with revision changes", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route("**/api/legal", (route) => route.fulfill({ json: {
    configured: true, operatorName: "Review Operator", contactEmail: "operator@example.com", publicOrigin: "https://connector.example.com",
    aboutUrl: "https://connector.example.com/about", termsUrl: "https://connector.example.com/terms", privacyUrl: "https://connector.example.com/privacy", iconUrl: "https://connector.example.com/assets/connector-icon.png",
  } }));
  await login(page);
  await openReview(page);
  await page.getByRole("button", { name: "Copy Terms of Service URL", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://connector.example.com/terms");
  await expect(page.getByLabel("TikTok website URL", { exact: true })).toHaveValue("https://connector.example.com/about");
  await page.getByRole("button", { name: "Copy TikTok Login Kit redirect URI", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://connector.example.com/api/oauth/tiktok/callback");
  await page.getByLabel("Changes since your last approved submission (revisions only)").fill("Adds public policy pages and a video preview.");
  await page.getByRole("button", { name: "Copy products and scopes explanation", exact: true }).click();
  const explanation = await page.evaluate(() => navigator.clipboard.readText());
  expect(explanation).toContain("user.info.basic");
  expect(explanation).toContain("video.publish");
  expect(explanation).toContain("video.list");
  expect(explanation).toContain("Changes in this revision: Adds public policy pages and a video preview.");
  expect(explanation).toContain("does not use Share Kit or the video.upload scope");
  await expect(page.getByRole("link", { name: "Download app icon (PNG)" })).toHaveAttribute("href", "/assets/connector-icon.png");
  const icon = await page.request.get("/assets/connector-icon.png");
  expect(icon.status()).toBe(200);
  expect(icon.headers()["content-type"]).toMatch(/image\/png/);
});

test("TikTok review rejects oversized and excess demo files and keeps accepted files local", async ({ page }) => {
  await login(page);
  await openReview(page);
  const picker = page.getByLabel("Check your demo files");
  await picker.setInputFiles({ name: "wrong-format.webm", mimeType: "video/webm", buffer: Buffer.from("fixture") });
  await expect(page.getByRole("alert").filter({ hasText: "use MP4 or MOV" })).toBeVisible();
  await picker.setInputFiles(Array.from({ length: 6 }, (_, index) => ({ name: `demo-${index}.mp4`, mimeType: "video/mp4", buffer: Buffer.from("fixture") })));
  await expect(page.getByRole("alert").filter({ hasText: "no more than five" })).toBeVisible();
  await picker.evaluate((element) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(50_000_001)], "too-large.mp4", { type: "video/mp4" }));
    (element as HTMLInputElement).files = data.files;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.getByRole("alert").filter({ hasText: "exceeds the 50 MB limit" })).toBeVisible();
  const uploads: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET") uploads.push(request.url()); });
  await picker.setInputFiles({ name: "real-recording.mp4", mimeType: "video/mp4", buffer: Buffer.from("fixture to validate selection, not a real demo") });
  await expect(page.getByText("1 file meets the format-name and size limits.", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Preview real-recording.mp4")).toHaveAttribute("src", /^blob:/);
  expect(uploads).toEqual([]);
});

test("TikTok domain verification publishes the original text without login and can be removed", async ({ page, request }) => {
  await login(page);
  await openReview(page);
  await page.getByText("TikTok asks me to upload a verification file", { exact: true }).click();
  const original = Buffer.from("\ufefftiktok-verification=browser-fixture\r\n\r\n");
  await page.getByLabel("TikTok website verification file", { exact: true }).setInputFiles({
    name: "tiktok-browser-check.txt", mimeType: "text/plain", buffer: original,
  });
  await page.getByRole("button", { name: "Publish verification file", exact: true }).click();
  await expect(page.getByText("Verification file published.", { exact: false })).toBeVisible();
  const publicFile = await request.get("/tiktok-browser-check.txt");
  expect(publicFile.status()).toBe(200);
  expect(await publicFile.body()).toEqual(original);
  await expect(page.getByRole("link", { name: "Preview verification file ↗" })).toHaveAttribute("href", "http://127.0.0.1:4173/tiktok-browser-check.txt");
  await page.getByRole("button", { name: "Remove verification file", exact: true }).click();
  await expect(page.getByText("Verification file removed from this installation.")).toBeVisible();
  expect((await request.get("/tiktok-browser-check.txt")).status()).toBe(404);
});

test("TikTok setup links to submission materials and remains usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await login(page);
  await page.getByLabel("Search platforms").fill("TikTok");
  const tiktok = page.locator(".provider-card").filter({ has: page.getByRole("heading", { name: "TikTok", exact: true }) });
  await tiktok.getByRole("button", { name: "Connect account", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Prepare TikTok submission" }).click();
  await expect(page.getByRole("dialog").getByLabel("App operator name")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "1. Create your TikTok developer account and web app" })).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("link", { name: "Open TikTok for Developers ↗" })).toHaveAttribute("href", "https://developers.tiktok.com/");
  await expect(page.getByRole("dialog").getByRole("heading", { name: "5. Add a sandbox test user and connect the account" })).toBeVisible();
  await expect(page.getByRole("dialog").getByLabel("Products and scopes explanation", { exact: true })).toHaveValue(/video.publish/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const dialog = page.getByRole("dialog");
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
