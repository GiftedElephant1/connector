import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Store } from '../server/store.ts';
// The dependency-free updater also runs before the package's TypeScript tools exist.
// @ts-expect-error This executable JavaScript module intentionally has no declaration dependency.
import { recoverInstallation, rootFiles, updateInstallation, validateUpdate } from '../scripts/update.mjs';

const key = '19'.repeat(32);
const moduleUrl = new URL('../scripts/update.mjs', import.meta.url).href;

async function write(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

async function bundle(root: string, version: string, existing = false) {
  await mkdir(root, { recursive: true });
  for (const name of rootFiles as string[]) {
    if (existing && name === 'Update Connector.vbs') continue;
    await write(join(root, name), `${version}: ${name}\n`);
  }
  await write(join(root, 'package.json'), JSON.stringify({ name: 'connector', private: true, version }));
  for (const name of ['client/main.tsx', 'server/index.ts', 'scripts/windows-launcher.ps1', 'docs/windows.md']) await write(join(root, name), `${version}: ${name}\n`);
  if (existing) {
    await write(join(root, 'node_modules/old-package/index.js'), 'previous dependency');
    await write(join(root, 'dist/index.html'), 'previous dashboard');
  }
}

async function prepare(stage: string) {
  await assert.rejects(() => readFile(join(stage, '.env')), /ENOENT/);
  await write(join(stage, 'node_modules/new-package/index.js'), 'new dependency');
  await write(join(stage, 'dist/index.html'), 'new dashboard');
}

async function fixture(t: TestContext, customData = './data') {
  const root = await mkdtemp(join(tmpdir(), 'connector-update-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'new download');
  const target = join(root, 'existing Connector');
  await bundle(source, '0.4.0');
  await bundle(target, '0.3.0', true);
  const env = `# Keep exact Windows formatting and secrets\r\nAPP_PASSWORD="private-password-value"\r\nENCRYPTION_KEY=${key}\r\nPIPELINE_API_KEY=${'private-pipeline-key-'.repeat(3)}\r\nDATA_DIR='${customData}'\r\nPORT=4317\r\n`;
  await write(join(target, '.env'), env);
  const data = resolve(target, customData);
  const db = join(data, 'connector.sqlite');
  const credential = { accessToken: 'private-saved-token', refreshToken: 'private-refresh-token', fields: { secret: 'private-app-secret' } };
  const settings = { ngrokToken: 'private-ngrok-token', oauthClientSecret: 'private-oauth-secret' };
  const values = { text: 'A saved scheduled post', idempotencyKey: 'private-idempotency-key' };
  const store = new Store(db, Buffer.from(key, 'hex'));
  try {
    store.save('openai', credential, { accountName: 'Saved account', accountId: 'account-123', resources: [] });
    store.writeSetting('configuration', settings);
    store.createJob('saved-job', 'fingerprint', 'openai', 'publish', values, Date.now() + 86_400_000);
  } finally { store.close(); }
  await write(join(data, 'extra/cache.sqlite-wal'), 'preserve other journal files');
  await write(join(data, 'extra/cache.sqlite-shm'), 'preserve other shared-memory files');
  await write(join(data, 'nested/private.json'), 'preserve user data outside database');
  await write(join(target, 'my-notes.txt'), 'unmanaged root files stay');
  return { root, source, target, data, db, env, credential, settings, values };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  const walk = async (path: string, prefix = '') => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), name + '/');
      else output[name] = (await readFile(join(path, entry.name))).toString('base64');
    }
  };
  await walk(root);
  return output;
}

for (const dataPath of ['./data', '../my private accounts', './private/accounts']) {
  test(`update preserves and reopens encrypted accounts, settings, and jobs in ${dataPath}`, async t => {
    const f = await fixture(t, dataPath);
    const privateBefore = await snapshot(f.data);
    await write(join(f.source, '.env'), 'ENCRYPTION_KEY=must-never-replace-the-original');
    await write(join(f.source, 'server/private.sqlite'), 'must not be copied');
    await write(join(f.source, 'client/.env.local'), 'must not be copied');
    const result = await updateInstallation({ source: f.source, target: f.target, prepare });
    assert.equal(result.currentVersion, '0.3.0');
    assert.equal(result.newVersion, '0.4.0');
    assert.equal(result.port, 4317);
    assert.equal(await readFile(join(f.target, '.env'), 'utf8'), f.env);
    assert.deepEqual(await snapshot(f.data), privateBefore);
    assert.equal(await readFile(join(f.target, 'my-notes.txt'), 'utf8'), 'unmanaged root files stay');
    assert.equal(await readFile(join(f.target, 'dist/index.html'), 'utf8'), 'new dashboard');
    await assert.rejects(() => readFile(join(f.target, 'node_modules/old-package/index.js')), /ENOENT/);
    await assert.rejects(() => readFile(join(f.target, 'server/private.sqlite')), /ENOENT/);
    await assert.rejects(() => readFile(join(f.target, 'client/.env.local')), /ENOENT/);
    await assert.rejects(() => readdir(join(f.target, '.connector-update')), /ENOENT/);
    const reopened = new Store(f.db, Buffer.from(parseEnv(await readFile(join(f.target, '.env'), 'utf8')).ENCRYPTION_KEY!, 'hex'));
    try {
      assert.deepEqual(reopened.credential('openai'), f.credential);
      assert.deepEqual(reopened.readSetting('configuration'), f.settings);
      assert.equal(reopened.job('saved-job')?.status, 'pending');
      assert.deepEqual(reopened.jobValues('saved-job'), f.values);
    } finally { reopened.close(); }
  });
}

test('failed dependency installation or build leaves the complete existing installation untouched', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.target);
  await assert.rejects(updateInstallation({ source: f.source, target: f.target, prepare: async (stage: string) => {
    await write(join(stage, 'dist/partial.html'), 'partial new build');
    throw new Error('simulated npm failure');
  } }), { code: 'PREPARATION_FAILED' });
  assert.deepEqual(await snapshot(f.target), before);
});

test('a replacement failure restores old code, dependencies, and exact private files', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.target);
  await assert.rejects(updateInstallation({ source: f.source, target: f.target, prepare, beforeReplace: (name: string) => {
    if (name === 'dist') throw new Error('simulated file lock');
  } }), { code: 'UPDATE_FAILED' });
  assert.deepEqual(await snapshot(f.target), before);
});

test('an interrupted replacement is recoverable on the next update without resetting credentials', async t => {
  const f = await fixture(t);
  const before = await snapshot(f.target);
  const script = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { updateInstallation } from ${JSON.stringify(moduleUrl)};
    await updateInstallation({ source: ${JSON.stringify(f.source)}, target: ${JSON.stringify(f.target)},
      prepare: async stage => {
        await mkdir(join(stage, 'node_modules'));
        await mkdir(join(stage, 'dist'));
        await writeFile(join(stage, 'dist/index.html'), 'new dashboard');
      },
      beforeReplace: name => { if (name === 'server') process.exit(77); }
    });`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 77, child.stderr);
  assert.equal((await validateUpdate({ source: f.source, target: f.target })).pendingRecovery, true);
  assert.equal(await recoverInstallation(f.target), true);
  assert.deepEqual(await snapshot(f.target), before);
  assert.equal(await recoverInstallation(f.target), false, 'recovery is safe to repeat');
  await updateInstallation({ source: f.source, target: f.target, prepare });
  assert.equal(await readFile(join(f.target, '.env'), 'utf8'), f.env);
});

test('an active updater cannot be recovered or replaced by a second updater', async t => {
  const f = await fixture(t);
  await updateInstallation({ source: f.source, target: f.target, prepare: async (stage: string) => {
    await assert.rejects(recoverInstallation(f.target), { code: 'UPDATE_BUSY' });
    await assert.rejects(updateInstallation({ source: f.source, target: f.target, prepare }), { code: 'UPDATE_BUSY' });
    const child = spawnSync(process.execPath, [fileURLToPath(moduleUrl), '--target', f.target, '--recover-only'], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(JSON.parse(child.stderr).code, 'UPDATE_BUSY');
    await prepare(stage);
  } });
});

test('an interruption before the first journal write can be recovered after the ownership grace period', async t => {
  const f = await fixture(t);
  const transaction = join(f.target, '.connector-update');
  await mkdir(transaction);
  await assert.rejects(recoverInstallation(f.target), { code: 'UPDATE_BUSY' });
  const earlier = new Date(Date.now() - 120_000);
  await utimes(transaction, earlier, earlier);
  assert.equal(await recoverInstallation(f.target), true);
  assert.equal(await readFile(join(f.target, '.env'), 'utf8'), f.env);
});

for (const dataPath of ['./server/private', './node_modules/private', './dist', '.', './.connector-update/accounts']) {
  test(`unsafe DATA_DIR ${dataPath} is rejected before changing code`, async t => {
    const f = await fixture(t);
    await write(join(f.target, '.env'), f.env.replace("DATA_DIR='./data'", `DATA_DIR='${dataPath}'`));
    const before = await snapshot(f.target);
    await assert.rejects(updateInstallation({ source: f.source, target: f.target, prepare }), { code: 'UNSAFE_DATA_DIRECTORY' });
    assert.deepEqual(await snapshot(f.target), before);
  });
}

test('inherited DATA_DIR is also checked because dotenv does not override it', async t => {
  const f = await fixture(t);
  const inherited = process.env.DATA_DIR;
  process.env.DATA_DIR = './client/private';
  try { await assert.rejects(validateUpdate({ source: f.source, target: f.target }), { code: 'UNSAFE_DATA_DIRECTORY' }); }
  finally { if (inherited === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = inherited; }
});

test('downgrades, unrelated folders, and source/target overlap are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(validateUpdate({ source: f.target, target: f.target }), { code: 'UNSAFE_PATH' });
  await assert.rejects(validateUpdate({ source: f.source, target: f.root }), { code: 'UNSAFE_PATH' });
  await write(join(f.source, 'package.json'), JSON.stringify({ name: 'connector', private: true, version: '0.2.9' }));
  await assert.rejects(validateUpdate({ source: f.source, target: f.target }), { code: 'DOWNGRADE' });
  await write(join(f.source, 'package.json'), JSON.stringify({ name: 'unrelated-application', private: true, version: '9.0.0' }));
  await assert.rejects(validateUpdate({ source: f.source, target: f.target }), { code: 'INVALID_BUNDLE' });
});

test('source symlinks and Windows junctions are rejected without traversing private files', async t => {
  const f = await fixture(t);
  await symlink(f.data, join(f.source, 'server/linked-accounts'), process.platform === 'win32' ? 'junction' : 'dir');
  const before = await snapshot(f.target);
  await assert.rejects(updateInstallation({ source: f.source, target: f.target, prepare }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await snapshot(f.target), before);
});

test('target directory aliases and managed-directory links cannot redirect replacement', async t => {
  const f = await fixture(t);
  const alias = join(f.root, 'alias');
  await symlink(f.target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateUpdate({ source: f.source, target: alias }), { code: 'UNSAFE_PATH' });
  await rm(join(f.target, 'dist'), { recursive: true });
  await symlink(f.data, join(f.target, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(validateUpdate({ source: f.source, target: f.target }), { code: 'UNSAFE_PATH' });
});

test('CLI reports a fixed error without echoing private configuration values', async t => {
  const f = await fixture(t);
  await write(join(f.target, '.env'), f.env.replace(key, 'a-sensitive-invalid-key'));
  const child = spawnSync(process.execPath, [fileURLToPath(moduleUrl), '--target', f.target, '--check-only'], { encoding: 'utf8' });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stderr).code, 'INVALID_CONFIGURATION');
  assert.equal(child.stderr.includes('a-sensitive-invalid-key'), false);
  assert.equal(child.stderr.includes('private-password-value'), false);
});
