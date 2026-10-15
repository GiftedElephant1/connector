import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsAdapters } from '../server/providers-ads.ts';
import { ProviderError } from '../server/provider-types.ts';

const microsoft = adsAdapters.find(adapter => adapter.definition.id === 'microsoft-ads')!;
const env = { MICROSOFT_CLIENT_ID: 'client-id', MICROSOFT_CLIENT_SECRET: 'private-client-secret', MICROSOFT_ADS_DEVELOPER_TOKEN: 'private-developer-token' };
const credential = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token' };
const input = { env, code: 'private-sign-in-code', codeVerifier: 'private-verifier', redirectUri: 'https://private-callback.example' };
const privateText = [...Object.values(env), ...Object.values(credential), input.code, input.codeVerifier, input.redirectUri, 'private-provider-message', 'private-tracking-id'].join(' ');
const stages = [
  { label: 'authorization code exchange', run: () => microsoft.exchange!(input) },
  { label: 'token refresh', run: () => microsoft.refresh!(credential, env) },
  { label: 'account verification', run: () => microsoft.verify(credential, env) },
];

async function failure(run: () => Promise<unknown>, pattern: RegExp, status = 401): Promise<string> {
  let message = '';
  await assert.rejects(run(), error => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, status);
    message = error.message;
    assert.match(message, pattern);
    for (const secret of privateText.split(' ')) assert.equal(message.includes(secret), false, `Leaked ${secret}`);
    return true;
  });
  return message;
}

test('Microsoft token failures preserve AADSTS and allowlisted OAuth codes without upstream descriptions', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    error: 'invalid_client', error_codes: [7000215], error_description: privateText,
    trace_id: 'private-tracking-id', correlation_id: 'private-tracking-id', access_token: credential.accessToken,
  }, { status: 401 }));
  for (const stage of stages.slice(0, 2)) {
    const message = await failure(stage.run, new RegExp(`${stage.label} failed \\(HTTP 401; AADSTS 7000215; OAuth invalid_client\\)`));
    assert.match(message, /secret Value from the same app registration/);
  }
});

test('Microsoft Advertising parses documented AdApiFaultDetail and Customer Management ApiFault codes', async t => {
  const bodies = [
    { Errors: [{ Code: 105, ErrorCode: 'InvalidCredentials', Detail: privateText, Message: privateText }], Type: 'AdApiFaultDetail' },
    { OperationErrors: [{ Code: 106, Details: privateText, Message: privateText }], Type: 'ApiFault' },
  ];
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status: 401 }));
  for (const value of bodies) {
    body = { ...value, TrackingId: 'private-tracking-id' };
    const message = await failure(stages[2].run, /account verification failed \(HTTP 401; provider code 10[56]\)/);
    assert.doesNotMatch(message, /client secret/);
    assert.match(message, 'Errors' in value ? /production Microsoft Advertising developer token/ : /does not have permission/);
  }
});

test('Microsoft identity and Advertising error formats cannot be confused', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status: 401 }));
  body = { error_codes: [7000215], error: 'invalid_client', error_description: privateText };
  const advertising = await failure(stages[2].run, /account verification failed \(HTTP 401\)/);
  assert.doesNotMatch(advertising, /AADSTS|invalid_client|7000215/);
  body = { Errors: [{ Code: 105, Message: privateText }], error: { code: 190 }, code: 105 };
  const exchange = await failure(stages[0].run, /authorization code exchange failed \(HTTP 401\)/);
  assert.doesNotMatch(exchange, /AADSTS|provider code/);
});

test('Microsoft ignores untrusted text, malformed codes, oversized bodies and unreadable responses', async t => {
  let response: () => Response;
  t.mock.method(globalThis, 'fetch', async () => response());
  for (const value of ['7000215', privateText, -1, 1.5, 2_147_483_648, true, null, {}, []]) {
    response = () => Response.json({ error_codes: [value], error: privateText, Errors: [{ Code: value, ErrorCode: privateText }] }, { status: 401 });
    for (const stage of stages) {
      const message = await failure(stage.run, new RegExp(`${stage.label} failed \\(HTTP 401\\)`));
      assert.doesNotMatch(message, /AADSTS|provider code|OAuth /);
    }
  }
  for (const body of [privateText, JSON.stringify({ error_codes: [7000215], error_description: 'x'.repeat(16_384) }), '[]']) {
    response = () => new Response(body, { status: 401 });
    await failure(stages[0].run, /authorization code exchange failed \(HTTP 401\)/);
  }
  response = () => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(privateText)); } }), { status: 401 });
  await failure(stages[0].run, /authorization code exchange failed \(HTTP 401\)/);
});

test('Microsoft preserves stage for transport errors, malformed responses, and HTTP semantics', async t => {
  let mode: 'network' | 'json' | 'shape' | number = 'network';
  t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'network') throw new Error(privateText);
    if (mode === 'json') return new Response(privateText);
    if (mode === 'shape') return Response.json([privateText]);
    return Response.json({ error_description: privateText }, { status: mode });
  });
  for (const stage of stages) {
    for (const value of ['network', 'json', 'shape', 400, 403, 429, 500] as const) {
      mode = value;
      const pattern = typeof value === 'number' ? `failed \\(HTTP ${value}\\)` : value === 'network' ? 'could not reach Microsoft' : 'returned an invalid response';
      const message = await failure(stage.run, new RegExp(`${stage.label} ${pattern}`), value === 403 || value === 429 ? value : 502);
      if (value === 429) assert.match(message, /rate limiting/);
    }
  }
});

test('Microsoft gives targeted guidance for documented credential, consent and account identity codes', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status: 401 }));
  for (const [code, expected] of [[7000222, /secret has expired/], [50011, /redirect URI/], [650052, /Microsoft Advertising API Service is not enabled/], [65001, /requires consent/], [50079, /security-information registration/]] as const) {
    body = { error_codes: [code], error_description: privateText };
    await failure(stages[0].run, expected);
  }
  for (const [code, expected] of [[109, /token has expired/], [116, /missing API header/], [117, /rate limiting/], [122, /Work or school account/], [123, /Personal account/], [126, /identity type does not match/]] as const) {
    body = { Errors: [{ Code: code, Message: privateText }] };
    await failure(stages[2].run, expected);
  }
  body = { error: 'invalid_grant', error_codes: [700082], error_description: privateText };
  const message = await failure(stages[1].run, /token refresh failed \(HTTP 401; AADSTS 700082; OAuth invalid_grant\)/);
  assert.match(message, /fresh Connect account attempt/);
});

test('Microsoft service failures do not suggest replacing credentials unless a credential code was returned', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body, { status: 500 }));
  for (const value of [{}, { Errors: [{ Code: 0, Message: privateText }] }]) {
    body = value;
    for (const stage of stages) {
      const message = await failure(stage.run, /service error/, 502);
      assert.doesNotMatch(message, /Check the production|check that the client ID/);
    }
  }
  body = { Errors: [{ Code: 105, Message: privateText }] };
  await failure(stages[2].run, /provider code 105.*production Microsoft Advertising developer token/, 502);
});
