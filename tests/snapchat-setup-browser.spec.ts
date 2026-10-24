import { expect, test, type Page } from '@playwright/test';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('Workspace password').fill('connector-browser-test-password');
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: /Your accounts, connected\.|First, make this workspace yours\./ })).toBeVisible();
  if (await page.getByLabel('Choose a password', { exact: true }).isVisible()) {
    await page.getByLabel('Choose a password', { exact: true }).fill('connector-browser-test-password');
    await page.getByLabel('Repeat your password', { exact: true }).fill('connector-browser-test-password');
    await page.getByRole('button', { name: 'Save password and continue' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Your accounts, connected.' })).toBeVisible();
}

async function openSetup(page: Page, name: string) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const row = page.locator('.settings-providers > div').filter({ has: page.locator('strong').filter({ hasText: new RegExp(`^${name}$`) }) });
  await row.getByRole('button', { name: 'Manage setup', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('region', { name: `${name} setup guide` })).toBeVisible();
  return dialog;
}

for (const advertising of [false, true]) {
  const name = advertising ? 'Snapchat Ads' : 'Snapchat';
  const provider = advertising ? 'snapchat-ads' : 'snapchat';
  const otherProvider = advertising ? 'snapchat' : 'snapchat-ads';
  const otherPrefix = advertising ? 'SNAPCHAT' : 'SNAPCHAT_ADS';
  const scope = advertising ? 'snapchat-marketing-api' : 'snapchat-profile-api';

  test(`${name} setup copies its callback and saves an independent OAuth configuration`, async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await login(page);
    const headers = { 'x-connector-request': '1' };
    expect((await page.request.put('/api/settings', { headers, data: { values: {
      [`${otherPrefix}_CLIENT_ID`]: 'other-snapchat-browser-app',
      [`${otherPrefix}_CLIENT_SECRET`]: 'other-snapchat-browser-secret',
    } } })).ok()).toBe(true);
    await page.route(`**/api/settings/providers/${provider}`, async route => {
      const response = await route.fetch();
      await route.fulfill({ json: { ...await response.json(), callbackUrl: `https://public-connector.example/api/oauth/${provider}/callback` } });
    });
    const dialog = await openSetup(page, name);
    await expect(dialog.getByLabel(`${name} permission Connector will request`, { exact: true })).toHaveValue(scope);
    if (!advertising) await expect(dialog.getByText(/Snapchat currently requires your app to be allowlisted/)).toBeVisible();
    await dialog.getByRole('button', { name: `Copy ${name} redirect URL`, exact: true }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`https://public-connector.example/api/oauth/${provider}/callback`);
    await dialog.getByLabel(`${name} client ID`, { exact: false }).fill('selected-snapchat-browser-app');
    await dialog.getByLabel(`${name} client secret`, { exact: false }).fill('selected-snapchat-browser-secret');
    if (!advertising) await dialog.getByLabel('Snapchat organization ID', { exact: false }).fill('00000000-0000-4000-8000-000000000001');
    await dialog.getByRole('button', { name: 'Save and continue', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    const started = await page.request.post(`/api/oauth/${provider}/start`, { headers });
    expect(started.ok()).toBe(true);
    const authorization = new URL((await started.json()).url);
    expect(authorization.origin).toBe('https://accounts.snapchat.com');
    expect(authorization.searchParams.get('client_id')).toBe('selected-snapchat-browser-app');
    expect(authorization.searchParams.get('scope')).toBe(scope);
    expect(new URL(authorization.searchParams.get('redirect_uri')!).pathname).toBe(`/api/oauth/${provider}/callback`);

    const other = await (await page.request.get(`/api/settings/providers/${otherProvider}`)).json();
    expect(other.fields.find((field: { key: string }) => field.key === `${otherPrefix}_CLIENT_ID`).value).toBe('other-snapchat-browser-app');
    expect(other.fields.find((field: { key: string }) => field.key === `${otherPrefix}_CLIENT_SECRET`).configured).toBe(true);
    const reopened = await openSetup(page, name);
    await expect(reopened.getByLabel(`${name} client ID`, { exact: false })).toHaveValue('selected-snapchat-browser-app');
    await expect(reopened.getByLabel(`${name} client secret`, { exact: false })).toHaveValue('');
    await expect(reopened.getByLabel(`${name} client secret`, { exact: false })).toHaveAttribute('placeholder', 'Already saved — leave blank to keep');
  });
}

test('Snapchat setup explains local access and fits a narrow screen for both connections', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await login(page);
  for (const name of ['Snapchat', 'Snapchat Ads']) {
    const dialog = await openSetup(page, name);
    await expect(dialog.getByText('Start public access in Settings, open the public workspace, and reopen this setup to copy your HTTPS redirect URL.', { exact: true })).toBeVisible();
    await expect(dialog.getByLabel(`${name} redirect URL`, { exact: true })).toHaveCount(0);
    await expect(dialog.getByText(/Snapchat and Snapchat Ads store separate credentials and authorizations/)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
});
