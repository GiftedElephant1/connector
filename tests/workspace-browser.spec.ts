import { expect, test, type Page } from "@playwright/test";
import { workspaceApps } from "../server/workspace-actions";

type Binding = { accountId: string; apps: string[] };
type Profile = {
  id: string;
  name: string;
  bindings: Binding[];
  defaultAccountId?: string;
  createdAt: string;
  updatedAt: string;
};
const timestamp = "2026-01-01T00:00:00.000Z";

async function openWorkspace(page: Page) {
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
  await page
    .getByRole("button", { name: "Google Workspace", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Google Workspace", exact: true }),
  ).toBeVisible();
}

async function mockWorkspace(page: Page) {
  const snapshot = {
    apps: workspaceApps,
    accounts: [
      {
        id: "work-account",
        email: "work@example.com",
        name: "Work",
        apps: ["gmail", "drive", "sheets"],
        requestedApps: ["gmail", "drive", "sheets", "docs"],
        missingApps: ["docs"],
        connectedAt: timestamp,
        mapsConfigured: false,
        status: "connected",
      },
      {
        id: "personal-account",
        email: "personal@example.com",
        name: "Personal",
        apps: ["tasks", "docs"],
        requestedApps: ["tasks", "docs"],
        missingApps: [],
        connectedAt: timestamp,
        mapsConfigured: false,
        status: "connected",
      },
    ],
    profiles: [] as Profile[],
    google: {
      configured: true,
      missing: [],
      callbackUrl: "https://connector.example/api/workspace/google/callback",
    },
    mcpUrl: "https://connector.example/mcp",
  };
  const writes: { method: string; path: string; body: unknown }[] = [];
  let count = 0;
  await page.route("**/api/workspace**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && path === "/api/workspace")
      return route.fulfill({ json: snapshot });
    if (method !== "GET") {
      expect(request.headers()["x-connector-request"]).toBe("1");
      writes.push({
        method,
        path,
        body: request.postData() ? request.postDataJSON() : null,
      });
    }
    if (method === "POST" && path === "/api/workspace/profiles") {
      const body = request.postDataJSON();
      const profile = {
        ...body,
        id: `agent-${++count}`,
        createdAt: timestamp,
        updatedAt: timestamp,
      } as Profile;
      snapshot.profiles.push(profile);
      return route.fulfill({
        json: { profile, apiKey: `workspace-secret-${count}` },
      });
    }
    const profileId = path.match(
      /^\/api\/workspace\/profiles\/([^/]+)(?:\/rotate-key)?$/,
    )?.[1];
    if (profileId) {
      const index = snapshot.profiles.findIndex(
        (profile) => profile.id === profileId,
      );
      if (index === -1)
        return route.fulfill({
          status: 404,
          json: { error: "Agent not found." },
        });
      if (method === "PUT") {
        snapshot.profiles[index] = {
          ...snapshot.profiles[index],
          ...request.postDataJSON(),
          defaultAccountId: request.postDataJSON().defaultAccountId,
        };
        return route.fulfill({ json: { profile: snapshot.profiles[index] } });
      }
      if (method === "POST")
        return route.fulfill({
          json: {
            profile: snapshot.profiles[index],
            apiKey: "replacement-workspace-secret",
          },
        });
      if (method === "DELETE") {
        snapshot.profiles.splice(index, 1);
        return route.fulfill({ json: { ok: true } });
      }
    }
    const mapsId = path.match(
      /^\/api\/workspace\/accounts\/([^/]+)\/maps-key$/,
    )?.[1];
    if (mapsId) {
      const account = snapshot.accounts.find(
        (account) => account.id === mapsId,
      )!;
      account.mapsConfigured = method === "PUT";
      account.apps = [
        ...account.apps.filter((app) => app !== "maps"),
        ...(account.mapsConfigured ? ["maps"] : []),
      ];
      return route.fulfill({ json: { account } });
    }
    if (path === "/api/workspace/google/start")
      return route.fulfill({
        status: 409,
        json: {
          error: "Open Connector at its public address to sign in with Google.",
        },
      });
    return route.fulfill({
      status: 404,
      json: { error: "Unexpected Workspace route." },
    });
  });
  return { snapshot, writes };
}

test("different agents receive different Google accounts and app permissions, with keys masked and copied once", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { snapshot, writes } = await mockWorkspace(page);
  await openWorkspace(page);
  await page.getByRole("button", { name: "Add AI agent", exact: true }).click();
  let form = page.getByRole("form", { name: "AI agent permissions" });
  await form.getByLabel("Agent name", { exact: true }).fill("Grok work");
  const work = form.getByRole("group", {
    name: "work@example.com",
    exact: true,
  });
  await expect(work.getByLabel("Google Docs", { exact: false })).toBeDisabled();
  await work.getByLabel("Gmail", { exact: true }).check();
  await work.getByLabel("Google Drive", { exact: true }).check();
  await expect(
    form.getByLabel("Default Google account for this agent"),
  ).toHaveValue("work-account");
  await form.getByRole("button", { name: "Create agent connection" }).click();
  let details = page.getByRole("region", {
    name: "Grok work connection details",
  });
  await expect(
    details.getByLabel("Agent connection key", { exact: true }),
  ).toHaveAttribute("type", "password");
  await details
    .getByRole("button", { name: "Copy Agent connection key", exact: true })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "workspace-secret-1",
  );
  await details
    .getByRole("button", {
      name: "Copy Google Workspace connector URL",
      exact: true,
    })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "https://connector.example/mcp",
  );
  await details
    .getByRole("button", { name: "I’ve saved these connection details" })
    .click();
  await expect(
    page.getByLabel("Agent connection key", { exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Add AI agent", exact: true }).click();
  form = page.getByRole("form", { name: "AI agent permissions" });
  await form.getByLabel("Agent name", { exact: true }).fill("Claude personal");
  await form
    .getByRole("group", { name: "personal@example.com" })
    .getByLabel("Google Tasks", { exact: true })
    .check();
  await form.getByRole("button", { name: "Create agent connection" }).click();
  details = page.getByRole("region", {
    name: "Claude personal connection details",
  });
  await expect(
    details.getByLabel("Agent connection key", { exact: true }),
  ).toHaveAttribute("type", "password");
  expect(
    snapshot.profiles.map(({ name, bindings, defaultAccountId }) => ({
      name,
      bindings,
      defaultAccountId,
    })),
  ).toEqual([
    {
      name: "Grok work",
      bindings: [{ accountId: "work-account", apps: ["gmail", "drive"] }],
      defaultAccountId: "work-account",
    },
    {
      name: "Claude personal",
      bindings: [{ accountId: "personal-account", apps: ["tasks"] }],
      defaultAccountId: "personal-account",
    },
  ]);
  expect(writes).toHaveLength(2);
  expect(snapshot.accounts).toHaveLength(2);
  await expect(
    page.getByRole("article", { name: "Grok work access" }),
  ).toContainText("work@example.com");
  await expect(
    page.getByRole("article", { name: "Claude personal access" }),
  ).not.toContainText("work@example.com");
});

test("agent access can span accounts, change its default, and replace a lost key without reconnecting Google", async ({
  page,
}) => {
  const { snapshot, writes } = await mockWorkspace(page);
  snapshot.profiles.push({
    id: "saved-agent",
    name: "Grok",
    bindings: [{ accountId: "work-account", apps: ["sheets"] }],
    defaultAccountId: "work-account",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await openWorkspace(page);
  const agent = page.getByRole("article", { name: "Grok access", exact: true });
  await agent.getByRole("button", { name: "Edit access" }).click();
  const form = page.getByRole("form", { name: "AI agent permissions" });
  await form
    .getByRole("group", { name: "personal@example.com" })
    .getByLabel("Google Docs", { exact: true })
    .check();
  await form
    .getByLabel("Default Google account for this agent")
    .selectOption("personal-account");
  await form.getByRole("button", { name: "Save agent access" }).click();
  await expect(agent).toContainText("personal@example.com");
  await expect(
    page.getByLabel("Agent connection key", { exact: true }),
  ).toHaveCount(0);
  expect(snapshot.profiles[0].defaultAccountId).toBe("personal-account");
  expect(snapshot.profiles[0].bindings).toEqual([
    { accountId: "work-account", apps: ["sheets"] },
    { accountId: "personal-account", apps: ["docs"] },
  ]);
  await agent.getByRole("button", { name: "Replace connection key" }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText(
    "previous key will stop working immediately",
  );
  expect(writes).toHaveLength(1);
  await confirmation
    .getByRole("button", { name: "Create replacement key" })
    .click();
  await expect(
    page.getByLabel("Agent connection key", { exact: true }),
  ).toHaveValue("replacement-workspace-secret");
  await expect(
    page.getByLabel("Agent connection key", { exact: true }),
  ).toHaveAttribute("type", "password");
  expect(writes.map((write) => write.path)).toEqual([
    "/api/workspace/profiles/saved-agent",
    "/api/workspace/profiles/saved-agent/rotate-key",
  ]);
  expect(snapshot.accounts.map((account) => account.id)).toEqual([
    "work-account",
    "personal-account",
  ]);
});

test("Google authorization selects apps, reports public-address problems, and Maps uses a separate masked project key", async ({
  page,
}) => {
  const { snapshot, writes } = await mockWorkspace(page);
  await openWorkspace(page);
  await page
    .getByRole("button", { name: "Connect Google account", exact: true })
    .click();
  const form = page.getByRole("form", { name: "Choose Google apps" });
  await expect(
    form.getByRole("button", { name: "Continue to Google" }),
  ).toBeDisabled();
  await form.getByLabel("Google Sheets", { exact: false }).check();
  await expect(form.getByLabel("Google Maps", { exact: false })).toBeDisabled();
  await expect(form).toContainText(
    "Personal calls, SMS, and voicemail are not available",
  );
  await form.getByRole("button", { name: "Continue to Google" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Open Connector at its public address",
  );
  expect(writes[0].body).toEqual({ apps: ["sheets"] });
  await form.getByRole("button", { name: "Cancel account connection" }).click();
  const account = page.getByRole("article", {
    name: "work@example.com",
    exact: true,
  });
  await account
    .getByRole("button", { name: "Connect Maps", exact: true })
    .click();
  await expect(account).toContainText(
    "does not access your personal saved places",
  );
  await expect(
    account.getByLabel("Maps API key", { exact: true }),
  ).toHaveAttribute("type", "password");
  await account
    .getByLabel("Maps API key", { exact: true })
    .fill("private-maps-key");
  await account.getByRole("button", { name: "Save Maps key" }).click();
  await expect(
    account.getByRole("button", { name: "Manage Maps key", exact: true }),
  ).toBeVisible();
  expect(snapshot.accounts[0].mapsConfigured).toBe(true);
  expect(snapshot.accounts[1].mapsConfigured).toBe(false);
  await expect(page.getByLabel("Maps API key", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add AI agent", exact: true }).click();
  const permissions = page.getByRole("form", { name: "AI agent permissions" });
  await expect(
    permissions
      .getByRole("group", { name: "work@example.com", exact: true })
      .getByLabel("Google Maps", { exact: true }),
  ).toBeEnabled();
  await expect(
    permissions
      .getByRole("group", { name: "personal@example.com", exact: true })
      .getByLabel("Google Maps", { exact: false }),
  ).toBeDisabled();
});

test("Workspace account selection and agent permissions fit a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 850 });
  const { snapshot } = await mockWorkspace(page);
  snapshot.accounts[0].email =
    "a-long-google-workspace-address@example-company.com";
  await openWorkspace(page);
  await page.getByRole("button", { name: "Add AI agent", exact: true }).click();
  const form = page.getByRole("form", { name: "AI agent permissions" });
  await form.getByLabel("Agent name", { exact: true }).fill("Grok on my phone");
  await form
    .getByRole("group", { name: snapshot.accounts[0].email, exact: true })
    .getByLabel("Google Sheets", { exact: true })
    .check();
  await expect(
    form.getByRole("button", { name: "Create agent connection" }),
  ).toBeEnabled();
  await page.screenshot({
    path: "test-results/workspace-mobile.png",
    fullPage: true,
  });
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll("body *")]
      .filter((element) => element.getBoundingClientRect().right > innerWidth)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        right: element.getBoundingClientRect().right,
      })),
  );
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
    JSON.stringify(overflow),
  ).toBeLessThanOrEqual(375);
});

test("an agent can require an explicit Google account without resetting that choice when permissions change", async ({
  page,
}) => {
  const { snapshot, writes } = await mockWorkspace(page);
  snapshot.profiles.push({
    id: "choose-account",
    name: "Choose each time",
    bindings: [
      { accountId: "work-account", apps: ["sheets"] },
      { accountId: "personal-account", apps: ["tasks"] },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  await openWorkspace(page);
  await page
    .getByRole("article", { name: "Choose each time access", exact: true })
    .getByRole("button", { name: "Edit access" })
    .click();
  const form = page.getByRole("form", { name: "AI agent permissions" });
  await expect(
    form.getByLabel("Default Google account for this agent"),
  ).toHaveValue("");
  await form
    .getByRole("group", { name: "work@example.com", exact: true })
    .getByLabel("Gmail", { exact: true })
    .check();
  await expect(
    form.getByLabel("Default Google account for this agent"),
  ).toHaveValue("");
  await form.getByRole("button", { name: "Save agent access" }).click();
  await expect(form).toHaveCount(0);
  expect(writes[0].body).not.toHaveProperty("defaultAccountId");
  expect(snapshot.profiles[0].defaultAccountId).toBeUndefined();
});
