import { expect, test, type Page, type Route } from "@playwright/test";

type ProviderId = "claude" | "chatgpt" | "gemini" | "cursor" | "grok";
type Provider = {
  id: ProviderId;
  name: string;
  enabled: boolean;
  configured: boolean;
  executable?: string;
  model?: string;
  hasApiKey?: boolean;
  hasWebhookUrl?: boolean;
  hasWebhookKey?: boolean;
  check?: { status: "ready" | "action_required" | "unavailable"; message: string; checkedAt: string };
};
type Task = {
  id: string;
  provider: ProviderId;
  status: "running" | "succeeded" | "failed" | "uncertain" | "cancelled" | "submitted";
  createdAt: string;
  updatedAt: string;
  prompt: string;
  result?: string;
  error?: string;
  link?: string;
};
type Write = { method: string; path: string; body: Record<string, unknown> };

function providerFixtures(): Provider[] {
  return [
    { id: "claude", name: "Claude", enabled: false, configured: false, executable: "claude" },
    { id: "chatgpt", name: "ChatGPT", enabled: false, configured: false, executable: "codex" },
    { id: "gemini", name: "Gemini", enabled: false, configured: false, executable: "agy" },
    { id: "cursor", name: "Cursor", enabled: false, configured: false, hasApiKey: false },
    { id: "grok", name: "Grok Bot", enabled: false, configured: false, hasWebhookUrl: false, hasWebhookKey: false },
  ];
}
const now = "2026-11-02T12:00:00.000Z";
function taskFixture(overrides: Partial<Task> = {}): Task {
  return { id: "task-one", provider: "claude", status: "running", createdAt: now, updatedAt: now, prompt: "Summarize this test note without changing any files.", ...overrides };
}
async function mockOutbound(page: Page, options: {
  providers?: Provider[];
  tasks?: Task[];
  onReadTask?: (route: Route, task: Task) => Promise<void>;
} = {}) {
  const state = {
    providers: options.providers ?? providerFixtures(),
    tasks: options.tasks ?? [],
    allowSharedKey: false,
    writes: [] as Write[],
    reads: [] as string[],
  };
  await page.route("**/api/ai/connectors", route => route.fulfill({ json: { url: "https://connector.example/mcp", grants: [], clients: [] } }));
  await page.route("**/api/outbound-ai**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET") {
      state.reads.push(path);
      if (path === "/api/outbound-ai") return route.fulfill({ json: { providers: state.providers, tasks: state.tasks, allowSharedKey: state.allowSharedKey } });
      const task = state.tasks.find(item => path === `/api/outbound-ai/tasks/${item.id}`);
      if (task) {
        if (options.onReadTask) return options.onReadTask(route, task);
        return route.fulfill({ json: { task } });
      }
      return route.fulfill({ status: 404, json: { error: "Unknown test task" } });
    }
    expect(request.headers()["x-connector-request"]).toBe("1");
    const body = request.postDataJSON() as Record<string, unknown>;
    state.writes.push({ method, path, body });
    if (path === "/api/outbound-ai/access") {
      state.allowSharedKey = body.allowSharedKey === true;
      return route.fulfill({ json: { allowSharedKey: state.allowSharedKey } });
    }
    if (path === "/api/outbound-ai/providers/cursor/models") {
      return route.fulfill({ json: { models: [
        { id: "included-model", name: "Subscription model", subscriptionEligible: true },
        { id: "paid-third-party", name: "Paid third-party model", subscriptionEligible: false },
      ] } });
    }
    const provider = state.providers.find(item => path === `/api/outbound-ai/providers/${item.id}` || path === `/api/outbound-ai/providers/${item.id}/check`);
    if (provider) {
      if (path.endsWith("/check")) {
        provider.check = { status: "ready", message: "Signed in with the subscription account.", checkedAt: now };
      } else {
        provider.enabled = body.enabled === true;
        if (typeof body.executable === "string") provider.executable = body.executable;
        if (typeof body.model === "string") provider.model = body.model;
        if (body.apiKey) provider.hasApiKey = true;
        if (body.webhookUrl) provider.hasWebhookUrl = true;
        if (body.webhookKey) provider.hasWebhookKey = true;
        provider.configured = true;
      }
      return route.fulfill({ json: { provider } });
    }
    expect(path, "The dashboard must never submit an owner-created AI task").not.toBe("/api/outbound-ai/tasks");
    const task = state.tasks.find(item => path === `/api/outbound-ai/tasks/${item.id}/cancel`);
    if (task) {
      task.status = "cancelled";
      return route.fulfill({ json: { task } });
    }
    return route.fulfill({ status: 404, json: { error: "Unexpected test route" } });
  });
  return state;
}
async function login(page: Page, path = "/") {
  await page.goto(path);
  await page.getByLabel("Workspace password").fill("connector-browser-test-password");
  await page.getByRole("button", { name: "Open workspace", exact: true }).click();
  await expect(page.getByRole("heading", { name: /Your accounts, connected\.|First, make this workspace yours\.|Authorize an AI connection/ })).toBeVisible();
  if (await page.getByLabel("Choose a password", { exact: true }).isVisible()) {
    await page.getByLabel("Choose a password", { exact: true }).fill("connector-browser-test-password");
    await page.getByLabel("Repeat your password", { exact: true }).fill("connector-browser-test-password");
    await page.getByRole("button", { name: "Save password and continue" }).click();
  }
}
async function openOutbound(page: Page) {
  await login(page);
  await page.getByRole("button", { name: "AI connections", exact: true }).click();
  const section = page.getByRole("region", { name: "Send tasks to AI agents", exact: true });
  await expect(section).toBeVisible();
  await expect(section.getByRole("form", { name: "New AI task", exact: true })).toHaveCount(0);
  await expect(section.getByLabel("Task instructions", { exact: true })).toHaveCount(0);
  await expect(section.getByRole("button", { name: "Send task", exact: true })).toHaveCount(0);
  await expect(section.getByText("Optional: test an AI task manually", { exact: true })).toHaveCount(0);
  return section;
}

test("local outbound setup is disabled until explicitly enabled and checks readiness without sending a task", async ({ page }) => {
  const state = await mockOutbound(page);
  const section = await openOutbound(page);
  for (const name of ["Claude", "ChatGPT", "Gemini", "Cursor", "Grok Bot"]) {
    await expect(section.getByRole("button", { name: `Configure ${name}`, exact: true })).toBeVisible();
  }
  await expect(section.getByRole("region", { name: "Authorize the AI that delegates tasks", exact: true })).toBeVisible();
  await expect(section.getByRole("checkbox", { name: "Allow the shared Connector key to send AI tasks", exact: true })).toBeVisible();
  await expect(section.getByRole("checkbox", { name: "Allow the shared Connector key to send AI tasks", exact: true })).not.toBeChecked();
  await expect(section.getByLabel("Task instructions", { exact: true })).toHaveCount(0);
  for (const [id, name, executable] of [
    ["claude", "Claude", "C:\\Tools\\Claude\\claude.exe"],
    ["chatgpt", "ChatGPT", "C:\\Tools\\Codex\\codex.exe"],
    ["gemini", "Gemini", "C:\\Tools\\Antigravity\\agy.exe"],
  ]) {
    await section.getByRole("button", { name: `Configure ${name}`, exact: true }).click();
    const form = section.getByRole("form", { name: `${name} outbound setup`, exact: true });
    await expect(form.getByRole("checkbox", { name: `Enable ${name} task sending`, exact: true })).not.toBeChecked();
    await form.getByLabel("Executable path (optional)", { exact: true }).fill(executable);
    await form.getByRole("checkbox", { name: `Enable ${name} task sending`, exact: true }).check();
    await form.getByRole("button", { name: "Save outbound setup", exact: true }).click();
    await expect.poll(() => state.writes.filter(item => item.path === `/api/outbound-ai/providers/${id}`).length).toBe(1);
    const write = state.writes.find(item => item.path === `/api/outbound-ai/providers/${id}`)!;
    expect(write.method).toBe("PUT");
    expect(write.body).toMatchObject({ enabled: true, executable });
    await form.getByRole("button", { name: "Check readiness", exact: true }).click();
    await expect(section).toContainText("Signed in with the subscription account.");
  }
  expect(state.writes.filter(item => item.path === "/api/outbound-ai/tasks")).toEqual([]);
  expect(state.reads.every(path => path === "/api/outbound-ai")).toBe(true);
});

test("Cursor offers only subscription models and private credentials stay masked and are retained when left blank", async ({ page }) => {
  const providers = providerFixtures();
  Object.assign(providers.find(item => item.id === "cursor")!, { configured: true, hasApiKey: true, model: "included-model" });
  Object.assign(providers.find(item => item.id === "grok")!, { configured: true, hasWebhookUrl: true, hasWebhookKey: true });
  const state = await mockOutbound(page, { providers });
  const section = await openOutbound(page);
  await section.getByRole("button", { name: "Configure Cursor", exact: true }).click();
  const cursor = section.getByRole("form", { name: "Cursor outbound setup", exact: true });
  const apiKey = cursor.getByLabel("Cursor API key", { exact: true });
  await expect(apiKey).toHaveValue("");
  await expect(apiKey).toHaveAttribute("type", "password");
  await cursor.getByRole("button", { name: "Load subscription models", exact: true }).click();
  const models = cursor.getByLabel("Cursor subscription model", { exact: true });
  await expect(models.locator('option[value="included-model"]')).toHaveCount(1);
  await expect(models.locator('option[value="paid-third-party"]')).toHaveCount(0);
  await models.selectOption("included-model");
  await cursor.getByRole("checkbox", { name: "Enable Cursor task sending", exact: true }).check();
  await cursor.getByRole("button", { name: "Save outbound setup", exact: true }).click();
  await expect.poll(() => state.writes.filter(item => item.path === "/api/outbound-ai/providers/cursor").length).toBe(1);
  const existingSave = state.writes.find(item => item.path === "/api/outbound-ai/providers/cursor")!;
  expect(existingSave.body.apiKey || "").toBe("");
  expect(existingSave.body).toMatchObject({ enabled: true, model: "included-model" });
  expect(providers.find(item => item.id === "cursor")!.hasApiKey).toBe(true);
  await apiKey.fill("cursor-private-browser-secret");
  await expect(cursor.getByRole("button", { name: "Save outbound setup", exact: true })).toBeDisabled();
  await cursor.getByRole("button", { name: "Load subscription models", exact: true }).click();
  await models.selectOption("included-model");
  await cursor.getByRole("button", { name: "Save outbound setup", exact: true }).click();
  await expect(apiKey).toHaveValue("");
  expect(state.writes.filter(item => item.path === "/api/outbound-ai/providers/cursor").at(-1)!.body.apiKey).toBe("cursor-private-browser-secret");
  await section.getByRole("button", { name: "Configure Grok Bot", exact: true }).click();
  const grok = section.getByRole("form", { name: "Grok Bot outbound setup", exact: true });
  for (const label of ["Grok routine webhook URL", "Grok routine webhook key"]) {
    await expect(grok.getByLabel(label, { exact: true })).toHaveValue("");
    await expect(grok.getByLabel(label, { exact: true })).toHaveAttribute("type", "password");
  }
  await grok.getByRole("button", { name: "Save outbound setup", exact: true }).click();
  await expect.poll(() => state.writes.filter(item => item.path === "/api/outbound-ai/providers/grok").length).toBe(1);
  const webhookSave = state.writes.find(item => item.path === "/api/outbound-ai/providers/grok")!;
  expect(webhookSave.body.webhookUrl || "").toBe("");
  expect(webhookSave.body.webhookKey || "").toBe("");
  expect(providers.find(item => item.id === "grok")!.hasWebhookUrl).toBe(true);
  expect(providers.find(item => item.id === "grok")!.hasWebhookKey).toBe(true);
  await expect(page.locator("body")).not.toContainText("cursor-private-browser-secret");
  expect(state.reads.every(path => path === "/api/outbound-ai")).toBe(true);
  expect(state.writes.filter(item => item.path === "/api/outbound-ai/tasks")).toEqual([]);
});

test("shared-key access requires its own explicit saved opt-in and does not send tasks", async ({ page }) => {
  const state = await mockOutbound(page);
  const section = await openOutbound(page);
  const checkbox = section.getByRole("checkbox", { name: "Allow the shared Connector key to send AI tasks", exact: true });
  await expect(checkbox).not.toBeChecked();
  expect(state.allowSharedKey).toBe(false);
  await checkbox.check();
  expect(state.writes).toEqual([]);
  await section.getByRole("button", { name: "Save shared-key access", exact: true }).click();
  await expect.poll(() => state.allowSharedKey).toBe(true);
  expect(state.writes).toEqual([{ method: "POST", path: "/api/outbound-ai/access", body: { allowSharedKey: true } }]);
  await checkbox.uncheck();
  await section.getByRole("button", { name: "Save shared-key access", exact: true }).click();
  await expect.poll(() => state.allowSharedKey).toBe(false);
  expect(state.writes).toHaveLength(2);
});

test("an AI client can receive only outbound task permission after explicit consent", async ({ page }) => {
  const writes: unknown[] = [];
  await page.route("**/api/ai/authorize/outbound-only", route => {
    if (route.request().method() === "GET") return route.fulfill({ json: {
      id: "outbound-only", clientName: "Test assistant", redirectUri: "https://client.example/return",
      scope: "connector", resource: "https://connector.example/mcp", expiresAt: new Date(Date.now() + 600000).toISOString(), workspaceProfiles: [],
    } });
    writes.push(route.request().postDataJSON());
    expect(route.request().headers()["x-connector-request"]).toBe("1");
    return route.fulfill({ json: { redirectUrl: "https://client.example/return?code=outbound-only" } });
  });
  await page.route("https://client.example/**", route => route.fulfill({ contentType: "text/html", body: "Returned to requesting app" }));
  await login(page, "/?authorize=outbound-only");
  const consent = page.getByRole("region", { name: "Authorize an AI connection", exact: true });
  const outbound = consent.getByRole("checkbox", { name: /Send tasks to AI agents/ });
  await expect(outbound).not.toBeChecked();
  await expect(consent.getByRole("checkbox", { name: /Standard platform tools/ })).not.toBeChecked();
  await expect(consent.getByRole("button", { name: "Approve selected access" })).toBeDisabled();
  expect(writes).toEqual([]);
  await outbound.check();
  await consent.getByRole("button", { name: "Approve selected access" }).click();
  await expect(page).toHaveURL("https://client.example/return?code=outbound-only");
  expect(writes).toEqual([{ approve: true, platforms: false, outbound: true }]);
});

function readyProvider(): Provider[] {
  return providerFixtures().map(provider => provider.id === "claude" ? {
    ...provider, enabled: true, configured: true,
    check: { status: "ready", message: "Signed in with the subscription account.", checkedAt: now },
  } : provider);
}

test("running task results refresh automatically and cancellation requires confirmation", async ({ page }) => {
  const running = taskFixture();
  let taskReads = 0;
  const state = await mockOutbound(page, {
    providers: readyProvider(), tasks: [running],
    onReadTask: async (route, task) => {
      taskReads++;
      if (task.id === "task-one" && taskReads > 1) {
        task.status = "succeeded";
        task.result = "Polled task result.";
      }
      return route.fulfill({ json: { task } });
    },
  });
  const section = await openOutbound(page);
  const history = section.getByRole("region", { name: "AI task history", exact: true });
  await expect(history).toContainText(running.prompt);
  await expect(history).toContainText("Polled task result.", { timeout: 15000 });
  expect(taskReads).toBeGreaterThan(0);
  const cancellable = taskFixture({ id: "task-two", prompt: "Another task awaiting completion." });
  state.tasks.push(cancellable);
  await section.getByRole("button", { name: "Refresh AI tasks", exact: true }).click();
  const card = history.locator('[data-task-id="task-two"]');
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Cancel task", exact: true }).click();
  expect(state.writes.some(item => item.path.endsWith("/cancel"))).toBe(false);
  await section.getByRole("button", { name: "Confirm cancel task", exact: true }).click();
  await expect(card).toContainText(/cancelled/i);
  expect(state.writes.filter(item => item.path.endsWith("/cancel"))).toEqual([{ method: "POST", path: "/api/outbound-ai/tasks/task-two/cancel", body: { confirmed: true } }]);
});

test("submitted Grok tasks remain distinct from completed results and outbound forms fit mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const state = await mockOutbound(page, { tasks: [taskFixture({ id: "grok-submitted", provider: "grok", status: "submitted", prompt: "Prepare a response in the Bot chat.", result: "Routine accepted. Read the result in Grok Bot." })] });
  const section = await openOutbound(page);
  const history = section.getByRole("region", { name: "AI task history", exact: true });
  await expect(history.locator('[data-task-id="grok-submitted"]')).toContainText(/submitted/i);
  await expect(history).toContainText("Read the result in Grok Bot.");
  for (const name of ["Claude", "ChatGPT", "Gemini", "Cursor", "Grok Bot"]) {
    await section.getByRole("button", { name: `Configure ${name}`, exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await expect(section.getByRole("form", { name: "New AI task", exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(state.writes).toEqual([]);
  await page.screenshot({ path: "test-results/outbound-ai-mobile.png", fullPage: true });
});

test("an uncertain Cursor task can be checked without submitting another task", async ({ page }) => {
  const uncertain = taskFixture({ id: "cursor-uncertain", provider: "cursor", status: "uncertain", prompt: "Review the draft without publishing it.", error: "The previous status request timed out." });
  let checks = 0;
  const state = await mockOutbound(page, {
    tasks: [uncertain],
    onReadTask: async (route, task) => {
      checks++;
      task.status = "succeeded";
      task.result = "The original Cursor task completed.";
      delete task.error;
      return route.fulfill({ json: { task } });
    },
  });
  const section = await openOutbound(page);
  const card = section.getByRole("region", { name: "AI task history", exact: true }).locator('[data-task-id="cursor-uncertain"]');
  await expect(card).toContainText("Result uncertain");
  await expect(card.getByRole("button", { name: "Cancel task", exact: true })).toBeVisible();
  expect(checks).toBe(0);
  await card.getByRole("button", { name: "Refresh task status", exact: true }).click();
  await expect(card).toContainText("Succeeded");
  await card.getByText("Task instructions and result", { exact: true }).click();
  await expect(card).toContainText("The original Cursor task completed.");
  await expect(card.getByRole("button", { name: "Refresh task status", exact: true })).toHaveCount(0);
  expect(checks).toBe(1);
  expect(state.writes).toEqual([]);
  expect(state.reads.filter(path => path.startsWith("/api/outbound-ai/tasks/"))).toEqual(["/api/outbound-ai/tasks/cursor-uncertain"]);
});

test("delegated AI tasks appear through history refresh without an owner submission", async ({ page }) => {
  const state = await mockOutbound(page, { providers: readyProvider() });
  const section = await openOutbound(page);
  await expect(section.getByRole("region", { name: "Authorize the AI that delegates tasks", exact: true })).toBeVisible();
  await expect(section.getByRole("checkbox", { name: "Allow the shared Connector key to send AI tasks", exact: true })).toBeVisible();
  await expect(section.getByLabel("Task instructions", { exact: true })).toHaveCount(0);
  const history = section.getByRole("region", { name: "AI task history", exact: true });
  await expect(history).toContainText("No tasks have been sent");
  await page.screenshot({ path: "test-results/outbound-delegation-default.png", fullPage: true });
  state.tasks.push(taskFixture({
    id: "delegated-by-grok", status: "succeeded",
    prompt: "Review the article drafted by my Grok Bot without publishing it.",
    result: "The delegated review is ready to return to Grok Bot.",
  }));
  await section.getByRole("button", { name: "Refresh AI tasks", exact: true }).click();
  const task = history.locator('[data-task-id="delegated-by-grok"]');
  await expect(task).toContainText("Succeeded");
  await task.getByText("Task instructions and result", { exact: true }).click();
  await expect(task).toContainText("The delegated review is ready to return to Grok Bot.");
  await expect(section.getByLabel("Task instructions", { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([]);
  expect(state.reads.every(path => path === "/api/outbound-ai")).toBe(true);
});

test("a delegated task changes from running to failed without any owner task submission", async ({ page }) => {
  const state = await mockOutbound(page, {
    providers: readyProvider(), tasks: [taskFixture({ prompt: "Check the draft supplied by Grok Bot without modifying anything." })],
    onReadTask: async (route, task) => {
      task.status = "failed";
      task.error = "Claude needs a fresh subscription sign-in. The task did not complete.";
      return route.fulfill({ json: { task } });
    },
  });
  const section = await openOutbound(page);
  const task = section.getByRole("region", { name: "AI task history", exact: true }).locator('[data-task-id="task-one"]');
  await expect(task.getByText("Running", { exact: true })).toBeVisible();
  await expect(task.getByText("Failed", { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(task.getByText("Running", { exact: true })).toHaveCount(0);
  await task.getByText("Task instructions and result", { exact: true }).click();
  await expect(task).toContainText("Claude needs a fresh subscription sign-in. The task did not complete.");
  await expect(task.getByRole("heading", { name: "Task instructions", exact: true })).toBeVisible();
  await expect(task).not.toContainText("Instructions sent");
  await expect(section).not.toContainText("Task accepted");
  expect(state.writes).toEqual([]);
});
