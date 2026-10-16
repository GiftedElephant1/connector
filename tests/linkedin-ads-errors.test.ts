import test from 'node:test';
import assert from 'node:assert/strict';
import { apiRequest, type ActionHttpFailure } from '../server/action-http';
import { linkedInAdsHttpOptions } from '../server/linkedin-ads-errors';
import { adsActions } from '../server/actions-ads';
import { ProviderError } from '../server/provider-types';

const endpoint = 'https://api.linkedin.com/rest/adCampaigns';
const secret = 'private-token-and-untrusted-provider-text';

test('campaign-list and spend actions propagate safe LinkedIn diagnostics without retrying the read', async t => {
  const request = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${secret}`);
    assert.equal(new URL(url).origin, 'https://api.linkedin.com');
    return Response.json({
      status: 400, serviceErrorCode: 100, code: 'ILLEGAL_ARGUMENT',
      message: `Rejected request ${url}; credential ${secret}`,
    }, { status: 400 });
  });
  for (const id of ['list-campaigns', 'read-spend']) {
    const action = adsActions.find(item => item.provider === 'linkedin-ads' && item.definition.id === id)!;
    await assert.rejects(action.execute({ accessToken: secret }, {
      accountId: '558713659', startDate: '2026-10-01', endDate: '2026-10-16',
    }, { LINKEDIN_VERSION: '202610' }), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 400);
      assert.match(error.message, /HTTP 400; provider code 100; ILLEGAL_ARGUMENT/);
      assert.doesNotMatch(error.message, /558713659|https:|private-token/);
      return true;
    });
  }
  assert.equal(request.mock.callCount(), 2, 'one GET per failed action and no retries');
});

test('LinkedIn Ads request errors expose only bounded diagnostic codes, not upstream text or URLs', async t => {
  const request = t.mock.method(globalThis, 'fetch', async () => Response.json({
    status: 400, serviceErrorCode: 100, code: 'ILLEGAL_ARGUMENT',
    message: `${secret} https://untrusted.example/?token=${secret}`,
    errorDetails: { input: secret },
  }, { status: 400 }));
  await assert.rejects(apiRequest('LinkedIn Ads', `${endpoint}?private=${secret}`, {
    method: 'POST', headers: { authorization: `Bearer ${secret}` }, body: secret,
  }, linkedInAdsHttpOptions), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 400);
    assert.match(error.message, /request format or parameters \(HTTP 400; provider code 100; ILLEGAL_ARGUMENT\)/);
    assert.match(error.message, /does not establish a billing or account-permission problem/);
    assert.doesNotMatch(error.message, /private-token|https:|errorDetails/);
    return true;
  });
  assert.equal(request.mock.callCount(), 1, 'failed writes must never be retried');
  const [, init] = request.mock.calls[0]!.arguments as unknown as [string, RequestInit];
  assert.equal(init.redirect, 'error');
});

test('LinkedIn Ads distinguishes rejected credentials from account permissions', async t => {
  let status = 401;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: status === 401 ? 'REVOKED_ACCESS_TOKEN' : 'ACCESS_DENIED' }, { status }));
  await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, linkedInAdsHttpOptions), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 401);
    assert.match(error.message, /access expired or was rejected \(HTTP 401; REVOKED_ACCESS_TOKEN\)/);
    assert.match(error.message, /Use LinkedIn Pages and Ads together/);
    return true;
  });
  status = 403;
  await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, linkedInAdsHttpOptions), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 403);
    assert.match(error.message, /approved Ads permissions.*member's access/);
    assert.doesNotMatch(error.message, /expired|billing/);
    return true;
  });
});

test('LinkedIn Ads reports version codes without reflecting provider explanations', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'NONEXISTENT_VERSION', message: secret }, { status: 426 }));
  await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, linkedInAdsHttpOptions), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /HTTP 426; NONEXISTENT_VERSION/);
    assert.match(error.message, /LinkedIn API version/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

test('LinkedIn Ads drops unknown string codes and invalid numeric codes', async t => {
  const bodies = [
    { serviceErrorCode: -1, code: secret },
    { serviceErrorCode: 2_147_483_648, code: 'ILLEGAL_ARGUMENT ' },
    { serviceErrorCode: '100', code: { token: secret } },
    { serviceErrorCode: 1.5, code: 'invalid_request' },
    { serviceErrorCode: null, code: null },
    [],
    null,
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json(bodies[index++]!, { status: 400 }));
  const diagnostics: ActionHttpFailure[] = [];
  for (const _ of bodies) {
    await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, {
      diagnosticFormat: 'linkedin-ads',
      failure: failure => { diagnostics.push(failure); return new ProviderError('safe error'); },
    }), /safe error/);
  }
  assert.deepEqual(diagnostics, bodies.map(() => ({ status: 400 })));
});

test('LinkedIn Ads retains supported numeric boundary codes', async t => {
  let code = 0;
  t.mock.method(globalThis, 'fetch', async () => Response.json({ serviceErrorCode: code }, { status: 400 }));
  const diagnostics: ActionHttpFailure[] = [];
  for (const nextCode of [0, 2_147_483_647]) {
    code = nextCode;
    await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, {
      diagnosticFormat: 'linkedin-ads',
      failure: failure => { diagnostics.push(failure); return new ProviderError('safe error'); },
    }), /safe error/);
  }
  assert.deepEqual(diagnostics, [{ status: 400, code: 0 }, { status: 400, code: 2_147_483_647 }]);
});

test('LinkedIn Ads handles malformed, empty, or unreadable error bodies without losing HTTP status', async t => {
  const unreadable = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error(secret)); } });
  const responses = [new Response(`<html>${secret}</html>`, { status: 400 }), new Response(null, { status: 400 }), new Response(unreadable, { status: 400 })];
  let index = 0;
  t.mock.method(globalThis, 'fetch', async () => responses[index++]!);
  for (const _ of responses) {
    await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, linkedInAdsHttpOptions), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /HTTP 400/);
      assert.doesNotMatch(error.message, /provider code/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

test('LinkedIn Ads cancels oversized bodies and drops partial diagnostics', async t => {
  let cancelled = false;
  let pulls = 0;
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(encoder.encode(pulls === 1 ? '{"serviceErrorCode":100,"code":"ILLEGAL_ARGUMENT","message":"' : secret.repeat(1_000)));
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const response = new Response(body, { status: 400 });
  t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, linkedInAdsHttpOptions), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.match(error.message, /HTTP 400/);
    assert.doesNotMatch(error.message, /provider code|ILLEGAL_ARGUMENT/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.equal(pulls, 2, 'do not read beyond the configured body limit');
});

test('LinkedIn diagnostics remain opt-in and other provider errors retain their existing behavior', async t => {
  const response = Response.json({ serviceErrorCode: 100, code: 'ILLEGAL_ARGUMENT', message: secret }, { status: 400 });
  const request = t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(apiRequest('Other provider', endpoint, { method: 'POST' }), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 502);
    assert.equal(error.message, 'Other provider could not complete this action (HTTP 400). Check the platform before retrying a write.');
    return true;
  });
  assert.equal(response.bodyUsed, false);
  assert.equal(request.mock.callCount(), 1);
});

test('LinkedIn options preserve successful actions, rate-limit behavior, and ambiguous network-failure guidance', async t => {
  let mode = 'success';
  const request = t.mock.method(globalThis, 'fetch', async () => {
    if (mode === 'network') throw new Error(secret);
    if (mode === 'rate-limit') return Response.json({ code: 'THROTTLED', message: secret }, { status: 429 });
    return Response.json({ elements: [] });
  });
  assert.deepEqual((await apiRequest('LinkedIn Ads', endpoint, {}, linkedInAdsHttpOptions)).body, { elements: [] });
  mode = 'rate-limit';
  await assert.rejects(apiRequest('LinkedIn Ads', endpoint, {}, linkedInAdsHttpOptions), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 429);
    assert.match(error.message, /HTTP 429; THROTTLED/);
    assert.match(error.message, /Check the platform before retrying a write/);
    return true;
  });
  mode = 'network';
  await assert.rejects(apiRequest('LinkedIn Ads', endpoint, { method: 'POST' }, linkedInAdsHttpOptions), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 502);
    assert.match(error.message, /it may have accepted the request/);
    assert.ok(!error.message.includes(secret));
    return true;
  });
  assert.equal(request.mock.callCount(), 3);
});
