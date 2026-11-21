import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OnePasswordCli, onePasswordEnvironment, onePasswordExecutableCandidates, runOnePassword, type OnePasswordRunOptions, type OnePasswordRunner } from '../server/onepassword-cli';
import { ProviderError } from '../server/provider-types';

const accountId = 'a'.repeat(26);
const vaultId = 'b'.repeat(26);
const itemId = 'c'.repeat(26);
const selection = { accountId, vaultId, itemId };
const privateValue = 'TEST-PRIVATE-VALUE-DO-NOT-RETURN';
const item = () => ({ id: itemId, vault: { id: vaultId, name: 'Credential vault' }, title: 'Application',
  fields: [
    { id: 'username', label: 'username', type: 'STRING', purpose: 'USERNAME', value: 'test-user' },
    { id: 'password', label: 'password', type: 'CONCEALED', purpose: 'PASSWORD', value: privateValue },
    { id: 'password', label: 'Other password', type: 'CONCEALED', value: 'another-private-value', section: { id: 'add more', label: 'Custom section' } },
  ], additionalPrivateProperty: privateValue });
const failure = (fragment?: string) => (error: unknown) => {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.message.includes(privateValue), false);
  if (fragment) assert.match(error.message, new RegExp(fragment));
  return true;
};
function fixture(output: unknown = item()) {
  const calls: { executable: string; args: string[]; options: OnePasswordRunOptions }[] = [];
  const run: OnePasswordRunner = async (executable, args, options) => {
    calls.push({ executable, args, options });
    return typeof output === 'string' ? output : JSON.stringify(output);
  };
  return { cli: new OnePasswordCli({ run, env: { PATH: '/usr/bin', HOME: '/example', OP_SERVICE_ACCOUNT_TOKEN: privateValue } }), calls };
}

test('1Password child environment keeps desktop basics and excludes secrets, sessions, hooks and proxy overrides', () => {
  const env = onePasswordEnvironment({
    HOME: '/example', USERPROFILE: 'C:\\Users\\example', Path: 'C:\\Tools', APPDATA: 'C:\\AppData',
    SystemRoot: 'C:\\Windows', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    CONNECTOR_API_KEY: privateValue, ENCRYPTION_KEY: privateValue, GOOGLE_CLIENT_SECRET: privateValue,
    OP_SERVICE_ACCOUNT_TOKEN: privateValue, OP_SESSION_example: privateValue, OP_CONNECT_TOKEN: privateValue,
    OP_CONNECT_HOST: 'https://other.example', OP_CONFIG_DIR: '/attacker', OP_ACCOUNT: 'different-account', OP_DEBUG: 'true',
    OP_BIOMETRIC_UNLOCK_ENABLED: 'false', OP_INCLUDE_ARCHIVE: 'true', NODE_OPTIONS: '--require /attacker', BASH_ENV: '/attacker', HTTPS_PROXY: privateValue,
  });
  assert.equal(env.HOME, '/example');
  assert.equal(env.Path, 'C:\\Tools');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.equal(env.OP_BIOMETRIC_UNLOCK_ENABLED, 'true');
  assert.equal(env.OP_DEBUG, 'false');
  assert.equal(env.OP_INCLUDE_ARCHIVE, 'false');
  assert.equal(JSON.stringify(env).includes(privateValue), false);
  for (const key of ['OP_CONFIG_DIR', 'OP_ACCOUNT', 'NODE_OPTIONS', 'BASH_ENV', 'HTTPS_PROXY']) assert.equal(env[key], undefined);
});

test('1Password check validates supported version without returning arbitrary command output', async () => {
  const good = fixture('2.33.1\n');
  assert.deepEqual((await good.cli.check('')).version, '2.33.1');
  assert.equal(good.calls[0].executable, 'op');
  assert.deepEqual(good.calls[0].args, ['--version']);
  assert.equal(good.calls[0].options.timeoutMs, 10_000);
  for (const output of [privateValue, '1.12.0', '2.30.0\n' + privateValue]) {
    const result = await fixture(output).cli.check('op');
    assert.equal(result.installed, false);
    assert.equal(result.version, undefined);
    assert.equal(JSON.stringify(result).includes(privateValue), false);
  }
});

test('account listing supports the CLI account_uuid schema and returns only account metadata', async () => {
  const f = fixture([{ account_uuid: accountId, user_uuid: 'd'.repeat(26), email: 'owner@example.test', url: 'example.1password.com', token: privateValue }]);
  assert.deepEqual(await f.cli.accounts('op'), [{ id: accountId, name: 'owner@example.test' }]);
  assert.deepEqual(f.calls[0].args, ['account', 'list', '--format=json']);
});

test('vault and item listing bind exact stable account/vault IDs and omit non-metadata properties', async () => {
  const vaults = fixture([{ id: vaultId, name: 'Shared', secret: privateValue }]);
  assert.deepEqual(await vaults.cli.vaults('op', accountId), [{ id: vaultId, name: 'Shared' }]);
  assert.deepEqual(vaults.calls[0].args, ['vault', 'list', '--account', accountId, '--format=json']);
  const items = fixture([{ id: itemId, title: 'Mailchimp', category: 'API_CREDENTIAL', additional_information: privateValue, urls: [{ href: privateValue }] }]);
  assert.deepEqual(await items.cli.items('op', accountId, vaultId), [{ id: itemId, title: 'Mailchimp', category: 'API_CREDENTIAL' }]);
  assert.deepEqual(items.calls[0].args, ['item', 'list', '--account', accountId, '--vault', vaultId, '--format=json']);
});

test('field selection never returns values and distinguishes duplicate IDs in separate sections', async () => {
  const f = fixture();
  const metadata = await f.cli.fields('op', selection);
  assert.equal(metadata.length, 3);
  assert.equal(new Set(metadata.map(field => field.id)).size, 3);
  assert.deepEqual(metadata.map(field => field.label), ['username', 'password', 'Custom section / Other password']);
  assert.equal(metadata[1].purpose, 'PASSWORD');
  assert.equal(JSON.stringify(metadata).includes(privateValue), false);
  assert.equal(JSON.stringify(metadata).includes('another-private-value'), false);
  assert.equal(JSON.stringify(metadata).includes('test-user'), false);
  assert.deepEqual(f.calls[0].args, ['item', 'get', itemId, '--account', accountId, '--vault', vaultId, '--format=json']);
  const again = await f.cli.fields('op', selection);
  assert.deepEqual(again, metadata, 'field selection identifiers are stable across reads');
});

test('server-only reads return exactly selected field values without including them in child arguments', async () => {
  const f = fixture();
  const fields = await f.cli.fields('op', selection);
  const selected = fields[1].id;
  assert.deepEqual(await f.cli.readFields('op', selection, [selected]), { [selected]: privateValue });
  assert.deepEqual(await f.cli.readFields('op', selection, [fields[2].id]), { [fields[2].id]: 'another-private-value' });
  assert.equal(JSON.stringify(f.calls).includes(privateValue), false);
  assert.ok(f.calls.every(call => call.options.maxOutputBytes <= 4 * 1024 * 1024));
  assert.ok(f.calls.every(call => call.options.timeoutMs === 90_000));
});

test('visible settings reject fields that became concealed after metadata selection using one current snapshot', async () => {
  let snapshot = item();
  const cli = new OnePasswordCli({ run: async () => JSON.stringify(snapshot) });
  const usernameId = (await cli.fields('op', selection))[0].id;
  assert.deepEqual(await cli.readFields('op', selection, [usernameId], [usernameId]), { [usernameId]: 'test-user' });
  snapshot = item();
  snapshot.fields[0].value = privateValue;
  for (const metadata of [{ type: 'CONCEALED', purpose: 'USERNAME' }, { type: 'STRING', purpose: 'PASSWORD' }]) {
    Object.assign(snapshot.fields[0], metadata);
    await assert.rejects(() => cli.readFields('op', selection, [usernameId], [usernameId]), failure('concealed'));
    assert.deepEqual(await cli.readFields('op', selection, [usernameId]), { [usernameId]: privateValue }, 'a secret target can still use its approved field');
  }
  await assert.rejects(() => cli.readFields('op', selection, [usernameId], ['f_otherfield']), failure('visible connection settings'));
});

test('Windows executable lookup finds a newly installed WinGet CLI without a refreshed PATH', () => {
  assert.deepEqual(onePasswordExecutableCandidates({ Path: 'C:\\Windows\\System32;.;relative', LocalAppData: 'C:\\Users\\Owner\\AppData\\Local' }, 'win32'), [
    'C:\\Windows\\System32\\op.exe', 'C:\\Users\\Owner\\AppData\\Local\\Microsoft\\WinGet\\Links\\op.exe',
  ]);
  assert.deepEqual(onePasswordExecutableCandidates({ LOCALAPPDATA: 'C:\\Users\\Owner\\AppData\\Local' }, 'win32'), [
    'C:\\Users\\Owner\\AppData\\Local\\Microsoft\\WinGet\\Links\\op.exe',
  ]);
  for (const localAppData of ['relative', '.', '\\\\remote\\share', '//remote/share', 'C:\\invalid\npath']) {
    assert.deepEqual(onePasswordExecutableCandidates({ LOCALAPPDATA: localAppData }, 'win32'), []);
  }
  assert.deepEqual(onePasswordExecutableCandidates({ PATH: '.:/usr/bin::relative', LOCALAPPDATA: '/ignored' }, 'linux'), ['/usr/bin/op']);
});

test('metadata and secret reads reject a wrong vault/item or ambiguous field identities', async () => {
  for (const bad of [
    { ...item(), id: 'd'.repeat(26) },
    { ...item(), vault: { id: 'd'.repeat(26) } },
    { ...item(), fields: [item().fields[1], item().fields[1]] },
    { ...item(), fields: [{ id: 'field\nnewline', value: privateValue }] },
  ]) await assert.rejects(() => fixture(bad).cli.fields('op', selection), failure());
});

test('untrusted account, vault, item and field selectors are rejected before invoking CLI', async () => {
  const f = fixture();
  for (const bad of ['--help', 'vault-name', '../../../tmp/item', 'a'.repeat(26) + '\n', '$(command)']) {
    await assert.rejects(() => f.cli.vaults('op', bad), failure());
    await assert.rejects(() => f.cli.items('op', accountId, bad), failure());
    await assert.rejects(() => f.cli.fields('op', { ...selection, itemId: bad }), failure());
  }
  for (const ids of [[], ['--help'], ['password'], ['op://vault/item/password'], Array(51).fill('f_aaaa')]) {
    await assert.rejects(() => f.cli.readFields('op', selection, ids), failure());
  }
  assert.equal(f.calls.length, 0);
});

test('missing, empty and multiline credential fields fail without returning any value', async () => {
  const selected = (await fixture().cli.fields('op', selection))[1].id;
  for (const value of ['', `${privateValue}\n`, `${privateValue}\r`, `${privateValue}\0`, 's'.repeat(8193), null]) {
    const result = item(); result.fields[1].value = value as string;
    await assert.rejects(() => fixture(result).cli.readFields('op', selection, [selected]), failure('missing, empty'));
  }
  const changed = item(); changed.fields.splice(1, 1);
  await assert.rejects(() => fixture(changed).cli.readFields('op', selection, [selected]), failure('missing, empty'));
});

test('CLI errors, malformed JSON and oversized output never include command output in errors', async () => {
  const errorCli = new OnePasswordCli({ run: async () => { throw new Error(privateValue); } });
  await assert.rejects(() => errorCli.accounts('op'), failure('Unlock'));
  assert.equal(JSON.stringify(await errorCli.check('op')).includes(privateValue), false);
  await assert.rejects(() => fixture(privateValue).cli.accounts('op'), failure('unsupported response'));
  await assert.rejects(() => fixture(privateValue.repeat(200_000)).cli.accounts('op'), failure('too large'));
  await assert.rejects(() => fixture(Array(101).fill({ account_uuid: accountId })).cli.accounts('op'), failure('oversized metadata'));
});

test('only the official executable name or an absolute local op path is accepted', async () => {
  const linux = fixture('2.33.1');
  for (const executable of ['op --help', './op', '/tmp/op.sh', '/tmp/node', '//remote/op']) {
    await assert.rejects(() => linux.cli.accounts(executable), failure('path'));
  }
  const calls: string[] = [];
  const win = new OnePasswordCli({ platform: 'win32', run: async executable => { calls.push(executable); return '2.33.1'; } });
  for (const executable of ['C:\\Tools\\op.cmd', 'C:\\Tools\\op.exe --help', '\\\\remote\\op.exe']) assert.equal((await win.check(executable)).installed, false);
  assert.equal((await win.check('C:\\Program Files\\1Password CLI\\op.exe')).installed, true);
  assert.deepEqual(calls, ['C:\\Program Files\\1Password CLI\\op.exe']);
  assert.equal(linux.calls.length, 0);
});

test('process runner bounds output and time and replaces process error details', async () => {
  const env = onePasswordEnvironment();
  const options = { env, timeoutMs: 3000, maxOutputBytes: 1024 };
  assert.equal(await runOnePassword(process.execPath, ['-e', 'process.stdout.write("ok")'], options), 'ok');
  for (const [args, limits] of [
    [['-e', `process.stderr.write(${JSON.stringify(privateValue)});process.exit(1)`], options],
    [['-e', 'process.stdout.write("s".repeat(10000))'], options],
    [['-e', 'setInterval(()=>{},1000)'], { ...options, timeoutMs: 30 }],
  ] as [string[], OnePasswordRunOptions][]) {
    await assert.rejects(() => runOnePassword(process.execPath, args, limits), error => {
      assert.equal(String(error).includes(privateValue), false);
      assert.equal(String(error).includes('process.'), false);
      return true;
    });
  }
});
