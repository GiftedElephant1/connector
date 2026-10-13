// Exercise the shipped updater with real npm installation, build, and app startup.
// All accounts and secrets below are disposable fixtures; no provider API is called.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { Store } from '../server/store.ts';
import { savePassword } from '../server/settings.ts';

if (!process.argv[2]) throw new Error('Pass the fully extracted and installed Connector package directory.');
const source = resolve(process.argv[2]);
const temporary = await mkdtemp(join(tmpdir(), 'connector-update-smoke-'));
const target = join(temporary, 'Existing Connector');
const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
const rootFiles = ['Start Connector.vbs', 'Update Connector.vbs', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', '.env.example', 'README.md'];
const directories = ['client', 'server', 'scripts', 'docs'];
const processEnv = { ...process.env };
// Real user/workspace configuration must never become part of this fixture.
for (const name of ['APP_ORIGIN', 'HOST', 'PORT', 'APP_PASSWORD', 'ENCRYPTION_KEY', 'PIPELINE_API_KEY', 'DATA_DIR', 'CONNECTOR_DESKTOP_TOKEN', 'DOTENV_CONFIG_PATH']) delete processEnv[name];

function start(args, options = {}) {
  const child = spawn(process.execPath, args, { cwd: target, env: processEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-20_000); });
  let startError;
  child.once('error', error => { startError = error; });
  const finished = new Promise(accept => child.once('close', (code, signal) => accept({ code, signal, error: startError })));
  return { child, finished, output: () => output };
}

async function run(args) {
  const execution = start(args);
  execution.child.stdin.end();
  const result = await execution.finished;
  assert.equal(result.error, undefined, 'The fixture command must start.');
  assert.equal(result.code, 0, `The fixture command failed: ${execution.output()}`);
  return execution.output();
}

async function availablePort() {
  const server = createServer();
  await new Promise((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  const port = server.address().port;
  await new Promise((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return port;
}

async function waitForApp(app, origin) {
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(app.child.exitCode, null, `The updated app exited: ${app.output()}`);
    try {
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        assert.equal(response.headers.get('x-connector-app'), 'gifted-elephant-connector');
        assert.equal((await response.json()).status, 'ok');
        return;
      }
    } catch { /* The server may still be loading its dependencies. */ }
    await delay(100);
  }
  throw new Error(`The updated app did not become healthy: ${app.output()}`);
}

async function stopApp(app) {
  if (!app || app.child.exitCode !== null || app.child.signalCode !== null) return;
  // Use the same shutdown channel as the Windows launcher so SQLite closes first.
  app.child.stdin.end('stop\n');
  const timer = new AbortController();
  const stopped = await Promise.race([app.finished, delay(10_000, null, { signal: timer.signal }).catch(() => null)]);
  timer.abort();
  if (!stopped) {
    app.child.kill();
    await app.finished;
    throw new Error('The updated app did not shut down through its desktop control channel.');
  }
  assert.equal(stopped.code, 0, `The updated app could not shut down cleanly: ${app.output()}`);
}

let app;
try {
  await mkdir(target);
  for (const name of [...rootFiles, ...directories]) await cp(join(source, name), join(target, name), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) {
    const manifest = JSON.parse(await readFile(join(target, name), 'utf8'));
    manifest.version = '0.3.0';
    if (manifest.packages?.['']) manifest.packages[''].version = '0.3.0';
    await writeFile(join(target, name), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  // Setup needs dotenv. A temporary link avoids copying dependencies; remove it
  // before updating so the updater must install and build everything itself.
  await symlink(join(source, 'node_modules'), join(target, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  try { await run(['scripts/setup.mjs']); }
  finally { await rm(join(target, 'node_modules'), { force: true, recursive: true }); }

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const envPath = join(target, '.env');
  const configuration = (await readFile(envPath, 'utf8'))
    .replace(/^APP_ORIGIN=.*$/m, `APP_ORIGIN=${origin}`)
    .replace(/^PORT=.*$/m, `PORT=${port}`)
    .replace(/^DATA_DIR=.*$/m, 'DATA_DIR="./saved accounts"');
  await writeFile(envPath, configuration, { mode: 0o600 });
  const privateEnv = parseEnv(configuration);
  const key = Buffer.from(privateEnv.ENCRYPTION_KEY, 'hex');
  const database = join(target, 'saved accounts', 'connector.sqlite');
  const ownerPassword = `fixture-owner-${randomBytes(24).toString('hex')}`;
  const credentials = {
    openai: { accessToken: 'fixture-openai-access-token' },
    discord: { accessToken: 'fixture-discord-access-token', refreshToken: 'fixture-discord-refresh-token', expiresAt: Date.now() + 86_400_000 },
    plaid: { accessToken: 'fixture-plaid-access-token', fields: { itemId: 'fixture-plaid-item', environment: 'sandbox', clientId: 'fixture-plaid-client' } },
  };
  const overrides = {
    APP_ORIGIN: 'https://update-smoke.example',
    DISCORD_CLIENT_ID: 'fixture-discord-client',
    DISCORD_CLIENT_SECRET: 'fixture-discord-client-secret',
    PLAID_CLIENT_ID: 'fixture-plaid-client',
    PLAID_SECRET: 'fixture-plaid-secret',
    PLAID_ENV: 'sandbox',
  };
  const tunnel = { authtoken: 'fixture-ngrok-authtoken', domain: 'fixture.ngrok.app', autoStart: false };
  const values = { channelId: '123456789012345678', content: 'A future scheduled fixture message.' };
  let expectedJob, expectedPassword, session;
  const summaries = {};
  const store = new Store(database, key);
  try {
    for (const [provider, credential] of Object.entries(credentials)) {
      summaries[provider] = store.save(provider, credential, { accountId: `fixture-${provider}`, accountName: `${provider} fixture account`, resources: [] });
    }
    store.writeSetting('provider-overrides', overrides);
    store.writeSetting('public-tunnel', tunnel);
    savePassword(store, ownerPassword);
    expectedPassword = store.readSetting('owner-password');
    session = store.createSession();
    expectedJob = store.createJob('update-smoke-pending-job', 'fixture-fingerprint', 'discord', 'publish-message', values, Date.now() + 86_400_000);
  } finally { store.close(); }
  const note = 'Private files alongside the app remain in place.\n';
  await writeFile(join(target, 'account-note.txt'), note);
  const envBefore = await readFile(envPath);

  console.log('Testing packaged update with real dependency installation and dashboard build.');
  const updateOutput = await run([join(source, 'scripts', 'update.mjs'), '--target', target]);
  for (const stage of ['installing', 'building', 'applying']) assert.match(updateOutput, new RegExp(`"stage":"${stage}"`));
  assert.match(updateOutput, /"event":"complete"/);
  assert.deepEqual(await readFile(envPath), envBefore, 'The encryption key, pipeline key, and all configuration bytes must remain unchanged.');
  assert.equal(await readFile(join(target, 'account-note.txt'), 'utf8'), note);
  assert.equal(JSON.parse(await readFile(join(target, 'package.json'), 'utf8')).version, sourceManifest.version);
  assert.equal(JSON.parse(await readFile(join(target, 'package-lock.json'), 'utf8')).version, sourceManifest.version);

  const { Store: UpdatedStore } = await import(pathToFileURL(join(target, 'server', 'store.ts')).href);
  const updatedStore = new UpdatedStore(database, key);
  try {
    for (const [provider, credential] of Object.entries(credentials)) {
      assert.deepEqual(updatedStore.credential(provider), credential, `${provider} credentials must still decrypt after updating.`);
      assert.deepEqual(updatedStore.connection(provider), summaries[provider]);
    }
    assert.deepEqual(updatedStore.readSetting('provider-overrides'), overrides);
    assert.deepEqual(updatedStore.readSetting('public-tunnel'), tunnel);
    assert.deepEqual(updatedStore.readSetting('owner-password'), expectedPassword);
    assert.equal(updatedStore.validSession(session), true);
    assert.deepEqual(updatedStore.job(expectedJob.id), expectedJob);
    assert.deepEqual(updatedStore.jobValues(expectedJob.id), values);
  } finally { updatedStore.close(); }

  app = start(['--import', 'tsx', 'server/index.ts'], { env: { ...processEnv, CONNECTOR_DESKTOP_TOKEN: randomBytes(32).toString('base64url') } });
  await waitForApp(app, origin);
  const login = await fetch(`${origin}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-connector-request': '1', origin }, body: JSON.stringify({ password: ownerPassword }),
  });
  assert.equal(login.status, 200, 'The saved owner password must sign in to the updated app.');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  const getJson = async (path, headers) => {
    const response = await fetch(`${origin}${path}`, { headers });
    assert.equal(response.status, 200, `${path} must remain available after updating.`);
    return response.json();
  };
  const providers = await getJson('/api/providers', { cookie });
  for (const [provider, summary] of Object.entries(summaries)) assert.deepEqual(providers.providers.find(item => item.id === provider)?.connection, summary);
  assert.equal((await getJson('/api/installation', { cookie })).version, sourceManifest.version);
  const connectorSettings = await getJson('/api/settings/pipeline-key', { cookie });
  assert.equal(connectorSettings.apiKey, privateEnv.PIPELINE_API_KEY);
  assert.equal(connectorSettings.url, `${overrides.APP_ORIGIN}/mcp`);
  const authorization = `Bearer ${privateEnv.PIPELINE_API_KEY}`;
  const connections = await getJson('/api/v1/connections', { authorization });
  for (const provider of Object.keys(credentials)) assert.equal(connections.connections.find(item => item.provider === provider)?.status, 'connected');
  assert.deepEqual((await getJson('/api/v1/jobs', { authorization })).jobs, [expectedJob]);
  const dashboard = await fetch(origin);
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /<!doctype html>/i);
  console.log(`Update smoke passed: version ${sourceManifest.version}, saved accounts, password, settings, schedules, and AI connector key work after upgrading.`);
} finally {
  try { await stopApp(app); }
  finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
