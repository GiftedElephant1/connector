import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { fetchJson } from '../server/provider-http.ts';
import { metaAdapters } from '../server/providers-meta.ts';
import { ProviderError } from '../server/provider-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const threads = metaAdapters.find((adapter) => adapter.definition.id === 'threads')!;
const secret = 'private-threads-secret';
const token = 'private-threads-token';
const code = 'private-authorization-code';
const env = { THREADS_APP_ID: 'threads-app', THREADS_APP_SECRET: secret };
const input = { code, redirectUri: 'https://connector.example/api/oauth/threads/callback', codeVerifier: 'verifier', env };
const credential = { accessToken: token };

async function publicFailure(action: () => Promise<unknown>, expected: RegExp, status = 502): Promise<string> {
  let message = '';
  await assert.rejects(action(), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, status);
    message = error.message;
    assert.match(message, expected);
    for (const privateValue of [secret, token, code, 'upstream-private-text', 'https://', 'fbtrace-private', 'Bearer']) {
      assert.equal(message.includes(privateValue), false, `Leaked private value: ${privateValue}`);
    }
    return true;
  });
  return message;
}

const stages = [
  { label: 'authorization code exchange', path: '/v1.0/oauth/access_token', action: () => threads.exchange!(input), count: 1 },
  { label: 'long-lived token exchange', path: '/v1.0/access_token', action: () => threads.exchange!(input), count: 2 },
  { label: 'profile verification', path: '/v1.0/me', action: () => threads.verify(credential, env), count: 1 },
  { label: 'token refresh', path: '/v1.0/refresh_access_token', action: () => threads.refresh!(credential, env), count: 1 },
];

for (const stage of stages) {
  test(`Threads identifies ${stage.label} failures without revealing credentials or advancing the flow`, async () => {
    let requests = 0;
    globalThis.fetch = async (url) => {
      requests += 1;
      if (new URL(String(url)).pathname !== stage.path) {
        assert.equal(stage.count, 2);
        return Response.json({ access_token: token, expires_in: 3600 });
      }
      return Response.json({ error: {
        code: 190, error_subcode: 463,
        message: `upstream-private-text ${secret} ${token} ${code} ${url}`,
        error_user_msg: 'Bearer private-threads-token', fbtrace_id: 'fbtrace-private',
      } }, { status: 400 });
    };
    const message = await publicFailure(stage.action, new RegExp(`Threads ${stage.label} failed \\(HTTP 400; provider code 190; subcode 463\\)`));
    assert.equal(requests, stage.count);
    assert.equal(message.includes('wrong secret'), false);
    if (stage.count === 2) assert.match(message, /sign-in code was accepted/);
  });
}

test('Threads recognizes only bounded integer codes in nested and legacy error formats', async () => {
  for (const body of [{ error_code: 1349245 }, { code: 100, error_subcode: 33 }]) {
    globalThis.fetch = async () => Response.json({ ...body, error_message: `upstream-private-text ${secret}` }, { status: 400 });
    const message = await publicFailure(() => threads.verify(credential, env), /profile verification failed/);
    assert.match(message, /provider code (1349245|100)/);
    if ('error_subcode' in body) assert.match(message, /subcode 33/);
  }
  for (const invalid of [secret, '190', -1, 1.5, 2_147_483_648, null, true, [], { code: 190 }]) {
    globalThis.fetch = async () => Response.json({
      error: { code: invalid, error_subcode: invalid, message: secret },
      error_code: invalid, code: invalid, error_subcode: invalid, fbtrace_id: secret,
    }, { status: 400 });
    const message = await publicFailure(() => threads.verify(credential, env), /profile verification failed \(HTTP 400\)/);
    assert.doesNotMatch(message, /provider code|subcode/);
  }
});

test('Threads non-JSON, oversized and unreadable error bodies retain HTTP status and stage', async () => {
  const bodies = [
    `<html>upstream-private-text ${secret} ${token}</html>`,
    JSON.stringify({ error: { code: 190, message: 'x'.repeat(16_384) } }),
  ];
  for (const body of bodies) {
    globalThis.fetch = async () => new Response(body, { status: 400 });
    const message = await publicFailure(() => threads.verify(credential, env), /profile verification failed \(HTTP 400\)/);
    assert.doesNotMatch(message, /provider code/);
  }
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) { controller.error(new Error(`upstream-private-text ${secret}`)); },
  }), { status: 400 });
  await publicFailure(() => threads.verify(credential, env), /profile verification failed \(HTTP 400\)/);
});

test('Threads transport and malformed successful responses retain the failing stage', async () => {
  for (const stage of stages) {
    for (const failure of ['network', 'non-json', 'array'] as const) {
      globalThis.fetch = async (url) => {
        if (new URL(String(url)).pathname !== stage.path) return Response.json({ access_token: token });
        if (failure === 'network') throw new Error(`${url} upstream-private-text ${secret}`);
        return failure === 'non-json' ? new Response(`upstream-private-text ${secret}`) : Response.json([token]);
      };
      await publicFailure(stage.action, new RegExp(`Threads ${stage.label} ${failure === 'network' ? 'could not reach the API' : 'returned an invalid response'}`));
    }
  }
});

test('Threads preserves authentication and rate-limit HTTP semantics with safe diagnostics', async () => {
  for (const status of [401, 403, 429]) {
    globalThis.fetch = async () => Response.json({ error: { code: 190, message: secret } }, { status });
    const message = await publicFailure(() => threads.verify(credential, env), new RegExp(`profile verification failed \\(HTTP ${status}; provider code 190\\)`), status);
    if (status === 429) assert.match(message, /rate limiting requests/);
  }
});

test('providers that do not opt in retain their existing redacted HTTP and network errors', async () => {
  globalThis.fetch = async () => Response.json({ error: { code: 190, message: secret } }, { status: 400 });
  assert.equal(await publicFailure(() => fetchJson('Other', 'https://provider.example'), /Other could not complete the request/),
    'Other could not complete the request (HTTP 400).');
  globalThis.fetch = async () => { throw new Error(secret); };
  assert.equal(await publicFailure(() => fetchJson('Other', 'https://provider.example'), /Other could not be reached/),
    'Other could not be reached. Check connectivity and try again.');
});
