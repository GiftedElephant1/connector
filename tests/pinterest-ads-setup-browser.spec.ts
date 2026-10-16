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

async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const row = page.locator('.settings-providers > div').filter({ has: page.locator('strong').filter({ hasText: /^Pinterest Ads$/ }) });
  await row.getByRole('button', { name: 'Manage setup', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Approve Pinterest advertising access', { exact: true })).toBeVisible();
  return dialog;
}

test('Pinterest Ads setup copies its own redirect and saves credentials independently from organic Pinterest', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await login(page);
  const headers = { 'x-connector-request': '1' };
  expect((await page.request.put('/api/settings', { headers, data: { values: { PINTEREST_CLIENT_ID: 'organic-browser-app', PINTEREST_CLIENT_SECRET: 'organic-browser-secret' } } })).ok()).toBe(true);
  await page.route('**/api/settings/providers/pinterest-ads', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), callbackUrl: 'https://public-connector.example/api/oauth/pinterest-ads/callback' } });
  });
  const dialog = await openSetup(page);
  await expect(dialog.getByRole('link', { name: 'Open Pinterest Ads developer portal ↗' })).toHaveAttribute('href', 'https://developers.pinterest.com/');
  await expect(dialog.getByLabel('Pinterest Ads permissions Connector will request', { exact: true })).toHaveValue('ads:read,ads:write');
  await dialog.getByRole('button', { name: 'Copy Pinterest Ads redirect URL', exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('https://public-connector.example/api/oauth/pinterest-ads/callback');
  await dialog.getByLabel('Pinterest Ads app ID', { exact: false }).fill('ads-browser-app');
  await dialog.getByLabel('Pinterest Ads app secret', { exact: false }).fill('ads-browser-secret');
  await dialog.getByRole('button', { name: 'Save and continue', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const started = await page.request.post('/api/oauth/pinterest-ads/start', { headers });
  expect(started.ok()).toBe(true);
  const authorization = new URL((await started.json()).url);
  expect(authorization.searchParams.get('client_id')).toBe('ads-browser-app');
  expect(authorization.searchParams.get('scope')).toBe('ads:read,ads:write');
  expect(new URL(authorization.searchParams.get('redirect_uri')!).pathname).toBe('/api/oauth/pinterest-ads/callback');
  const organic = await (await page.request.get('/api/settings/providers/pinterest')).json();
  expect(organic.fields.find((field: { key: string }) => field.key === 'PINTEREST_CLIENT_ID').value).toBe('organic-browser-app');
  expect(organic.fields.find((field: { key: string }) => field.key === 'PINTEREST_CLIENT_SECRET').configured).toBe(true);
  const reopened = await openSetup(page);
  await expect(reopened.getByLabel('Pinterest Ads app ID', { exact: false })).toHaveValue('ads-browser-app');
  await expect(reopened.getByLabel('Pinterest Ads app secret', { exact: false })).toHaveValue('');
  await expect(reopened.getByLabel('Pinterest Ads app secret', { exact: false })).toHaveAttribute('placeholder', 'Already saved — leave blank to keep');
});

test('Pinterest Ads setup explains public access and fits narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await login(page);
  const dialog = await openSetup(page);
  await expect(dialog.getByText('Start public access in Settings, open the public workspace, and reopen this setup to copy your HTTPS redirect URL.', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Pinterest Ads redirect URL', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/Pinterest Ads stores its own credentials and authorization/)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
});
