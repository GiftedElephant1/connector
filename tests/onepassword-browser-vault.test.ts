import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OnePasswordCli, type OnePasswordRunner } from '../server/onepassword-cli';
import { ProviderError } from '../server/provider-types';

const accountA = 'a'.repeat(26);
const accountB = 'b'.repeat(26);
const vaultA = 'c'.repeat(26);
const vaultB = 'd'.repeat(26);
const itemA = 'e'.repeat(26);
const itemB = 'f'.repeat(26);
const origin = 'https://login.example.test';
const secret = 'test-private-password-NEVER-RETURN';
const username = 'test-private-username';
const selection = { accountId: accountA, vaultId: vaultA, itemId: itemA };
const summary = (id = itemA, vault = vaultA, href = `${origin}/sign-in`) => ({
  id, title: 'Work account', category: 'LOGIN', vault: { id: vault, name: 'Shared team vault' },
  urls: [{ href, primary: true }], archived: false,
  additional_information: secret, fields: [{ value: secret }], notesPlain: secret,
});
const savedItem = (): Record<string, unknown> => ({
  ...summary(),
  fields: [
    { id: 'username', purpose: 'USERNAME', type: 'STRING', value: username },
    { id: 'password', purpose: 'PASSWORD', type: 'CONCEALED', value: secret },
    { id: 'notesPlain', type: 'STRING', value: 'Private notes are never returned' },
  ],
});
const failure = (fragment?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.message.includes(secret), false);
  assert.equal(error.message.includes(username), false);
  if (fragment) assert.match(error.message, fragment);
  return true;
};
function fixture(options: {
  accounts?: unknown;
  catalogs?: Record<string, unknown>;
  item?: unknown;
  onCall?: (args: string[]) => void;
} = {}) {
  const calls: string[][] = [];
  const run: OnePasswordRunner = async (_executable, args) => {
    calls.push(args);
    options.onCall?.(args);
    let result: unknown;
    if (args[0] === 'account') result = options.accounts ?? [
      { account_uuid: accountA, email: 'owner@example.test', token: secret },
      { account_uuid: accountB, name: 'Family account', token: secret },
    ];
    else if (args[1] === 'list') {
      const account = args[args.indexOf('--account') + 1];
      result = options.catalogs?.[account] ?? (account === accountA ? [summary()] : [summary(itemB, vaultB)]);
    } else result = options.item ?? savedItem();
    if (result instanceof Error) throw result;
    return JSON.stringify(result);
  };
  return { cli: new OnePasswordCli({ run }), calls };
}

test('browser login discovery searches all signed-in accounts without a vault filter and projects only matching metadata', async () => {
  const { cli, calls } = fixture();
  const result = await cli.browserLogins('op', origin);
  assert.deepEqual(result, [
    { ...selection, title: 'Work account', accountName: 'owner@example.test', vaultName: 'Shared team vault', origins: [origin] },
    { accountId: accountB, vaultId: vaultB, itemId: itemB, title: 'Work account', accountName: 'Family account', vaultName: 'Shared team vault', origins: [origin] },
  ]);
  assert.deepEqual(calls, [
    ['account', 'list', '--format=json'],
    ['item', 'list', '--account', accountA, '--format=json'],
    ['item', 'list', '--account', accountB, '--format=json'],
  ]);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(username), false);
  assert.equal(JSON.stringify(result).includes('/sign-in'), false);
});

test('browser login discovery uses exact stored HTTPS origins and never guesses from the title', async () => {
  const urls = [
    `${origin}:443/path?password=${secret}#fragment`,
    'https://login.example.test.attacker.test/',
    'https://sub.login.example.test/',
    'http://login.example.test/',
    'https://login.example.test:8443/',
    'https://owner:password@login.example.test/',
    'https://attacker.test/login.example.test',
    'https://login.example.test\\@attacker.test/',
    'https://login.example.test\n/',
    'javascript:alert(1)',
  ];
  const catalog: unknown[] = urls.map((url, index) => ({ ...summary(String(index).repeat(26), vaultA, url), title: origin }));
  catalog.push({ ...summary('k'.repeat(26)), urls: undefined, title: origin });
  const { cli } = fixture({ catalogs: { [accountA]: catalog, [accountB]: [] } });
  const result = await cli.browserLogins('op', origin);
  assert.equal(result.length, 1);
  assert.equal(result[0].itemId, '0'.repeat(26));
  assert.deepEqual(result[0].origins, [origin]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('browser login discovery excludes archived, trashed, inactive and non-login items', async () => {
  const catalog = [
    summary(),
    { ...summary('g'.repeat(26)), archived: true },
    { ...summary('h'.repeat(26)), trashed: true },
    { ...summary('i'.repeat(26)), state: 'ARCHIVED' },
    { ...summary('j'.repeat(26)), category: 'CREDIT_CARD' },
    { ...summary('k'.repeat(26)), category: 'API_CREDENTIAL' },
    { ...summary('l'.repeat(26)), archived: 'false' },
  ];
  const { cli } = fixture({ catalogs: { [accountA]: catalog, [accountB]: [] } });
  assert.deepEqual((await cli.browserLogins('op', origin)).map(login => login.itemId), [itemA]);
});

test('browser discovery never returns partial results if another account cannot be read', async () => {
  const { cli, calls } = fixture({ catalogs: { [accountB]: new Error(secret) } });
  await assert.rejects(() => cli.browserLogins('op', origin), failure(/Unlock/));
  assert.equal(calls.length, 3, 'a later account failure must not turn a first-account match into a unique result');
});

test('browser discovery guards every CLI boundary and stops after access revocation', async () => {
  let allowed = true;
  const revoked = new Error('Access revoked');
  const { cli, calls } = fixture({ onCall: args => { if (args[0] === 'item') allowed = false; } });
  let guardCount = 0;
  await assert.rejects(() => cli.browserLogins('op', origin, () => { guardCount++; if (!allowed) throw revoked; }), error => error === revoked);
  assert.equal(calls.length, 2, 'do not start reading the next account after revocation');
  assert.equal(guardCount, 4);
  calls.length = 0;
  await assert.rejects(() => cli.browserLogins('op', origin, () => { throw revoked; }), error => error === revoked);
  assert.equal(calls.length, 0);
});

test('browser discovery rejects invalid origins before calling 1Password', async () => {
  const { cli, calls } = fixture();
  for (const bad of ['http://example.test', 'https://example.test/', `${origin}/path`, `${origin}:8443`, 'https://owner:secret@example.test', 'not a URL']) {
    await assert.rejects(() => cli.browserLogins('op', bad), failure(/HTTPS/));
  }
  assert.equal(calls.length, 0);
});

test('browser discovery fails on ambiguous identities or malformed catalogs instead of selecting a partial match', async () => {
  for (const catalogs of [
    { [accountA]: [summary(), summary()] },
    { [accountA]: [{ ...summary(), id: '--help' }] },
    { [accountA]: [{ ...summary(), vault: { name: 'Missing ID' } }] },
    { [accountA]: [{ ...summary(), urls: 'not a URL array' }] },
    { [accountA]: { items: [summary()], truncated: true } },
    { [accountA]: Array(5001).fill(summary()) },
  ]) {
    await assert.rejects(() => fixture({ catalogs }).cli.browserLogins('op', origin), failure());
  }
  const duplicated = fixture({ accounts: [{ account_uuid: accountA }, { account_uuid: accountA }] });
  await assert.rejects(() => duplicated.cli.browserLogins('op', origin), failure(/duplicate accounts/));
  assert.equal(duplicated.calls.length, 1);
});

test('browser credential read retrieves current website binding and built-in credentials in one fresh item read', async () => {
  const { cli, calls } = fixture({ item: { ...savedItem(), urls: [{ href: 'https://new.example.test/sign-in' }] } });
  const result = await cli.browserCredential('op', selection);
  assert.deepEqual(result, { origins: ['https://new.example.test'], username, password: secret });
  assert.deepEqual(calls, [['item', 'get', itemA, '--account', accountA, '--vault', vaultA, '--format=json']]);
  assert.equal(JSON.stringify(calls).includes(secret), false);
  assert.equal(JSON.stringify(calls).includes(username), false);
  assert.equal(Object.keys(result).length, 3, 'never forward notes, fields, title or unrelated item properties');
});

test('browser credential read validates the identity and active Login category again', async () => {
  for (const item of [
    { ...savedItem(), id: itemB },
    { ...savedItem(), vault: { id: vaultB } },
    { ...savedItem(), category: 'API_CREDENTIAL' },
    { ...savedItem(), archived: true },
    { ...savedItem(), trashed: true },
    { ...savedItem(), state: 'ARCHIVED' },
    { ...savedItem(), urls: [{ href: 'http://login.example.test' }] },
    { ...savedItem(), urls: [] },
  ]) await assert.rejects(() => fixture({ item }).cli.browserCredential('op', selection), failure());
});

test('browser credential read refuses missing, sectional, duplicate or disguised credential fields', async () => {
  const fields = savedItem().fields as Record<string, unknown>[];
  for (const changed of [
    fields.slice(1),
    fields.filter(field => field.id !== 'password'),
    fields.map(field => field.id === 'password' ? { ...field, section: { id: 'custom' } } : field),
    [...fields, fields[1]],
    [...fields, { ...fields[1], id: 'other-password' }],
    fields.map(field => field.id === 'password' ? { ...field, id: 'custom-password' } : field),
    fields.map(field => field.id === 'password' ? { ...field, type: 'URL' } : field),
    fields.map(field => field.id === 'username' ? { ...field, type: 'CONCEALED' } : field),
    fields.map(field => field.id === 'password' ? { ...field, purpose: undefined } : field),
  ]) await assert.rejects(() => fixture({ item: { ...savedItem(), fields: changed } }).cli.browserCredential('op', selection), failure());
});

test('browser credential read ignores custom section credentials when one built-in pair is present', async () => {
  const fields = savedItem().fields as Record<string, unknown>[];
  const item = { ...savedItem(), fields: [...fields, { ...fields[1], value: 'a different secret', section: { id: 'custom section' } }] };
  assert.deepEqual(await fixture({ item }).cli.browserCredential('op', selection), { origins: [origin], username, password: secret });
});

test('browser credential read rejects unsupported values without echoing them', async () => {
  const fields = savedItem().fields as Record<string, unknown>[];
  for (const fieldId of ['username', 'password']) {
    for (const value of ['', null, secret + '\n', secret + '\r', secret + '\0', 's'.repeat(8193)]) {
      const item = { ...savedItem(), fields: fields.map(field => field.id === fieldId ? { ...field, value } : field) };
      await assert.rejects(() => fixture({ item }).cli.browserCredential('op', selection), failure());
    }
  }
});

test('browser credential read validates stable selectors before invoking the CLI and sanitizes its errors', async () => {
  const { cli, calls } = fixture();
  for (const key of ['accountId', 'vaultId', 'itemId']) {
    await assert.rejects(() => cli.browserCredential('op', { ...selection, [key]: '--help' }), failure());
  }
  assert.equal(calls.length, 0);
  await assert.rejects(() => fixture({ item: new Error(secret) }).cli.browserCredential('op', selection), failure(/Unlock/));
});
