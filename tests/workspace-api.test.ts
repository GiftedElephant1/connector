import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ActionValues } from '../server/action-types';
import { workspaceApiActions } from '../server/workspace-api';
import { ProviderError } from '../server/provider-types';
import { validateValues } from '../server/actions';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'workspace-api-private-access-token' };
const find = (app: string, id = 'read-api') => {
  const adapter = workspaceApiActions.find(entry => entry.provider === app && entry.definition.id === id);
  assert.ok(adapter);
  return adapter;
};
const run = (app: string, values: ActionValues, write = false) => find(app, write ? 'write-api' : 'read-api').execute(credential, values, {});

function mock(body: unknown, inspect: (url: URL, init?: RequestInit) => void = () => {}) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('authorization'), `Bearer ${credential.accessToken}`);
    assert.equal(headers.get('accept'), 'application/json');
    assert.equal(headers.get('x-http-method-override'), null);
    assert.equal(url.href.includes(credential.accessToken), false);
    inspect(url, init);
    return Response.json(body);
  };
}

test('advanced catalog exposes bounded official API features with separate read/write classifications and scopes', () => {
  assert.equal(workspaceApiActions.length, 16);
  assert.equal(new Set(workspaceApiActions.map(entry => `${entry.provider}:${entry.definition.id}`)).size, 16);
  assert.equal(workspaceApiActions.some(entry => ['maps', 'voice'].includes(entry.provider)), false);
  for (const adapter of workspaceApiActions) {
    assert.equal(adapter.definition.kind, adapter.definition.id === 'read-api' ? 'read' : 'write');
    assert.ok(adapter.requiredScopes?.length);
    assert.match(adapter.definition.description, /https:\/\/developers.google.com\//);
    assert.equal(adapter.definition.schedulable, undefined);
    assert.equal(adapter.definition.fields.some(field => field.name === 'method'), adapter.definition.kind === 'write');
    assert.equal(adapter.definition.fields.some(field => field.name === 'bodyJson'), adapter.definition.kind === 'write');
  }
  assert.deepEqual(find('gmail').requiredScopes, ['https://www.googleapis.com/auth/gmail.readonly']);
  assert.deepEqual(find('drive', 'write-api').requiredScopes, ['https://www.googleapis.com/auth/drive']);
  assert.match(find('gmail', 'write-api').definition.description, /service-account domain-wide delegation are not supported/);
  assert.match(find('meet').definition.description, /does not join calls or create Calendar invitations/);
});

test('read-api returns complete nested JSON, query controls, and opaque pagination without following arbitrary destinations', async () => {
  const response = { documentId: 'doc123', tabs: [{ documentTab: { body: { content: [{ table: { rows: 2, columns: 3 } }] } } }], nextPageToken: 'opaque:next/token' };
  mock(response, (url, init) => {
    assert.equal(url.origin + url.pathname, 'https://docs.googleapis.com/v1/documents/doc123');
    assert.equal(url.searchParams.get('includeTabsContent'), 'true');
    assert.equal(url.searchParams.get('pageSize'), '25');
    assert.equal(url.searchParams.get('pageToken'), 'previous:opaque/token');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.body, undefined);
  });
  const result = await run('docs', { path: '/documents/doc123', queryJson: JSON.stringify({ includeTabsContent: true, pageSize: 25, pageToken: 'previous:opaque/token' }) });
  assert.deepEqual(JSON.parse(String(result.items?.[0].responseJson)), response);
  assert.equal(result.items?.[0].truncated, false);
  assert.match(result.summary, /More results are available/);
});

test('Sheets advanced values writes preserve formulas and percent-encoded A1 path ranges', async () => {
  mock({ updatedCells: 2 }, (url, init) => {
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(decodeURIComponent(url.pathname), "/v4/spreadsheets/sheet123/values/'My Sheet'!A1:B1");
    assert.equal(url.searchParams.get('valueInputOption'), 'USER_ENTERED');
    assert.equal(init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(init?.body)), { values: [['=SUM(1,2)', 3]] });
  });
  await run('sheets', { path: "/spreadsheets/sheet123/values/'My%20Sheet'!A1:B1", method: 'PUT', queryJson: '{"valueInputOption":"USER_ENTERED"}', bodyJson: '{"values":[["=SUM(1,2)",3]]}' }, true);
});

for (const app of ['sheets', 'docs', 'slides']) test(`${app} structured batchUpdate forwards native requests without flattening`, async () => {
  const root = { sheets: 'spreadsheets', docs: 'documents', slides: 'presentations' }[app];
  const request = { requests: [{ replaceAllText: { containsText: { text: '{{title}}', matchCase: true }, replaceText: '  New title\n' } }], writeControl: { requiredRevisionId: 'revision1' } };
  mock({ replies: [{}] }, (url, init) => {
    assert.equal(url.hostname, `${app}.googleapis.com`);
    assert.ok(url.pathname.endsWith(`/${root}/file123:batchUpdate`));
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), request);
  });
  const result = await run(app, { path: `/${root}/file123:batchUpdate`, method: 'POST', bodyJson: JSON.stringify(request) }, true);
  assert.deepEqual(JSON.parse(String(result.items?.[0].responseJson)), { replies: [{}] });
});

test('all app API destinations stay separate and Gmail uses selected-user me endpoints', async () => {
  const cases = [
    ['gmail', '/profile', 'https://gmail.googleapis.com/gmail/v1/users/me/profile'],
    ['drive', '/files', 'https://www.googleapis.com/drive/v3/files'],
    ['meet', '/spaces/abc-defg-hij', 'https://meet.googleapis.com/v2/spaces/abc-defg-hij'],
    ['chat', '/users/me/spaces/space123/spaceReadState', 'https://chat.googleapis.com/v1/users/me/spaces/space123/spaceReadState'],
    ['tasks', '/users/@me/lists', 'https://tasks.googleapis.com/tasks/v1/users/@me/lists'],
  ];
  for (const [app, path, expected] of cases) {
    mock({}, (url) => assert.equal(url.toString(), expected));
    await run(app, { path });
  }
});

test('unsafe, absolute, traversing, encoded escaping, and malformed paths fail before any request', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  const paths = [
    '', '/', 'files', 'https://evil.example/data', '//evil.example/data', '/files//id', '/files/../users/other', '/files/./id',
    '/files/%2e%2e/users/other', '/files/.%2E/users/other', '/files/%252e%252e/users/other', '/files/%2F..%2Fusers',
    '/files/%5c..%5cusers', '/files/\\..\\users', '/files/id?access_token=x', '/files/id#fragment', '/files/%3Fid=x',
    '/files/%23fragment', '/files/%00', '/files/%0A', '/files/%7f', '/files/bad%ff', '/files/%', '/files/white space',
  ];
  for (const path of paths) await assert.rejects(run('gmail', { path }), ProviderError, path);
  assert.equal(calls, 0);
});

test('read-api refuses method/body mutation, and query authentication/method override cannot bypass confirmation', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const key of ['access_token', 'oauth_token', 'key', 'api_key', 'authorization', 'client_secret', 'refresh_token', 'callback', 'jsonp', '_method', '$httpMethod', 'X-HTTP-Method-Override', 'x_method_override', 'uploadType', 'upload_protocol']) {
    await assert.rejects(run('gmail', { path: '/messages/id', queryJson: JSON.stringify({ [key]: 'DELETE' }) }), /unsupported parameter/);
  }
  await assert.rejects(run('gmail', { path: '/messages/id', method: 'DELETE' }), /only permits GET/);
  await assert.rejects(run('gmail', { path: '/messages/id', bodyJson: '{}' }), /only permits GET/);
  for (const key of ['headers', 'authorization', 'url']) await assert.rejects(run('gmail', { path: '/messages/id', [key]: 'unexpected' }), /Custom URLs/);
  for (const method of ['GET', 'HEAD', 'TRACE', 'OPTIONS', 'CONNECT', 'DELETE\nX:evil']) await assert.rejects(run('gmail', { path: '/messages/id', method }, true), /requires POST/);
  await assert.rejects(run('drive', { path: '/files/file123', queryJson: '{"alt":"media"}' }), /Only JSON/);
  assert.equal(calls, 0);
});

test('query arrays encode repeated scalars and reject nested objects, controls, and null', async () => {
  mock({}, (url) => {
    assert.deepEqual(url.searchParams.getAll('resourceNames'), ['spaces/a', 'spaces/b']);
    assert.equal(url.searchParams.get('fields'), 'spaces(name,displayName),nextPageToken');
  });
  await run('chat', { path: '/spaces', queryJson: '{"resourceNames":["spaces/a","spaces/b"],"fields":"spaces(name,displayName),nextPageToken"}' });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const queryJson of ['{"pageSize":null}', '{"q":{"nested":true}}', '{"q":[["nested"]]}', '{"pageToken":"bad\\nvalue"}', '{"q":[]}', '{"q":1e400}']) {
    await assert.rejects(run('drive', { path: '/files', queryJson }), ProviderError);
  }
  assert.equal(calls, 0);
});

test('JSON request shape, nesting, cardinality, UTF-8 bytes, and action validation limits are enforced', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const bodyJson of ['null', '[]', '"a"', '{bad}', '{"n":1e400}', '{"a":'.repeat(55) + '{}' + '}'.repeat(55), JSON.stringify({ data: 'é'.repeat(250_000) }), JSON.stringify({ rows: Array.from({ length: 50_001 }, () => 1) })]) {
    await assert.rejects(run('docs', { path: '/documents/id:batchUpdate', method: 'POST', bodyJson }, true), ProviderError);
  }
  await assert.rejects(run('drive', { path: '/files', queryJson: JSON.stringify({ q: 'x'.repeat(10_000) }) }), /exceeds 10,000/);
  assert.equal(calls, 0);
  const adapter = find('docs', 'write-api');
  const bodyJson = JSON.stringify({ requests: [{ insertText: { text: 'x'.repeat(70_000) } }] });
  assert.equal(validateValues(adapter, { method: 'POST', path: '/documents/id:batchUpdate', bodyJson }).bodyJson, bodyJson);
  assert.throws(() => validateValues(adapter, { method: 'POST', path: '/documents/id:batchUpdate', bodyJson: 'x'.repeat(500_001) }), ProviderError);
});

test('DELETE with no response body succeeds as HTTP204 rather than producing a JSON parsing error', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), 'https://tasks.googleapis.com/tasks/v1/lists/list123/tasks/task123');
    assert.equal(init?.method, 'DELETE');
    assert.equal(init?.body, undefined);
    return new Response(null, { status: 204 });
  };
  const result = await run('tasks', { path: '/lists/list123/tasks/task123', method: 'DELETE' }, true);
  assert.match(result.summary, /no content/);
  assert.equal(result.items?.[0].status, 204);
  assert.equal(result.items?.[0].responseJson, 'null');
});

test('streamed or declared response overflows are explicit and writes retain uncertain completion status', async () => {
  for (const declared of [false, true]) for (const write of [false, true]) {
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1_048_577)); },
      cancel() { cancelled = true; },
    }), { headers: declared ? { 'content-length': '1048577' } : {} });
    await assert.rejects(run('docs', { path: '/documents/id', ...(write ? { method: 'PATCH', bodyJson: '{}' } : {}) }, write), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, write ? 502 : 413);
      assert.match(error.message, /Nothing was truncated/);
      if (write) assert.match(error.message, /may have succeeded/);
      return true;
    });
    assert.equal(cancelled, true);
  }
});

test('provider failures never echo response content or credentials; non-JSON and embedded errors are not successes', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: `SECRET: ${credential.accessToken}` } }), { status });
    await assert.rejects(run('gmail', { path: '/messages/id' }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(credential.accessToken), false);
      assert.equal(error.status, status === 500 ? 502 : status);
      return true;
    });
  }
  globalThis.fetch = async () => new Response('<html>not JSON</html>');
  await assert.rejects(run('drive', { path: '/files/id' }), /non-JSON/);
  mock({ error: { message: credential.accessToken } });
  await assert.rejects(run('drive', { path: '/files/id' }), /reported an API error/);
  globalThis.fetch = async () => { throw new Error(credential.accessToken); };
  await assert.rejects(run('drive', { path: '/files/id', method: 'PATCH', bodyJson: '{"name":"new"}' }, true), /may have succeeded/);
});
