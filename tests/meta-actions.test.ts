import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { metaActions } from '../server/actions-meta';
import { createOAuthRequest } from '../server/providers';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'user-token' };
const env = { META_APP_ID: 'app-id', META_APP_SECRET: 'app-secret', THREADS_APP_ID: 'threads-app', THREADS_APP_SECRET: 'threads-secret' };
const action = (provider: string, id: string) => metaActions.find((item) => item.provider === provider && item.definition.id === id)!;
const pageList = { data: [{ id: '123', name: 'Page', access_token: 'page-token', instagram_business_account: { id: '456' } }] };

function mockGraph(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.facebook.com');
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const token = new Headers(init?.headers).get('authorization')?.slice(7);
    assert.ok(['user-token', 'page-token'].includes(token || ''));
    assert.equal(url.searchParams.get('appsecret_proof'), createHmac('sha256', 'app-secret').update(token!).digest('hex'));
    assert.equal(url.searchParams.has('access_token'), false);
    if (url.pathname.endsWith('/me/accounts')) {
      assert.equal(token, 'user-token');
      assert.equal(init?.method, undefined);
      return Response.json(pageList);
    }
    return handler(url, init);
  };
}

test('Meta OAuth requests action permissions only on their relevant provider', () => {
  const input = { env, state: 'state', codeVerifier: 'verifier', redirectUri: 'https://connector.example/callback' };
  const facebook = new URL(createOAuthRequest('facebook', input)).searchParams.get('scope')!.split(',');
  assert.ok(facebook.includes('pages_manage_posts'));
  assert.ok(facebook.includes('pages_manage_engagement'));
  assert.ok(facebook.includes('pages_messaging'));
  assert.equal(facebook.includes('ads_management'), false);
  const ads = new URL(createOAuthRequest('meta-business', input)).searchParams.get('scope')!.split(',');
  assert.ok(ads.includes('ads_management'));
  const instagram = new URL(createOAuthRequest('instagram', input)).searchParams.get('scope')!.split(',');
  assert.ok(instagram.includes('instagram_content_publish'));
  assert.ok(instagram.includes('instagram_manage_messages'));
});

test('Facebook publishes using the derived Page token and only validated links', async () => {
  let writes = 0;
  mockGraph((url, init) => {
    assert.equal(url.pathname, '/v26.0/123/feed');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer page-token');
    assert.deepEqual(JSON.parse(String(init?.body)), { message: 'Hello', link: 'https://example.com/' });
    writes += 1;
    return Response.json({ id: '123_999' });
  });
  const result = await action('facebook', 'publish-post').execute(credential, { pageId: '123', message: 'Hello', link: 'https://example.com' }, env);
  assert.equal(result.items?.[0].postId, '123_999');
  assert.equal(JSON.stringify(result).includes('page-token'), false);
  await assert.rejects(action('facebook', 'publish-post').execute(credential, { pageId: '123', message: 'Hello', link: 'http://example.com' }, env), /HTTPS/);
  assert.equal(writes, 1);
});

test('Facebook Page lookup does not require unrelated Instagram permissions', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/me/accounts')) {
      assert.equal(url.searchParams.get('fields'), 'id,name,access_token');
      return Response.json(pageList);
    }
    return Response.json({ id: '123_999' });
  };
  await action('facebook', 'publish-post').execute(credential, { pageId: '123', message: 'Hello' }, env);
});

test('Meta rejects an inaccessible Page before performing a write', async () => {
  let writes = 0;
  mockGraph(() => { writes += 1; return Response.json({ id: '999' }); });
  await assert.rejects(action('facebook', 'publish-post').execute(credential, { pageId: '9999', message: 'Hello' }, env), /No accessible Page token/);
  assert.equal(writes, 0);
});

test('Facebook comments and Instagram replies use their documented distinct edges', async () => {
  mockGraph((url, init) => {
    assert.equal(init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(init?.body)), { message: 'Thank you' });
    assert.ok(['/v26.0/888/comments', '/v26.0/888/replies'].includes(url.pathname));
    return Response.json({ id: '999' });
  });
  await action('facebook', 'reply-comment').execute(credential, { pageId: '123', commentId: '888', message: 'Thank you' }, env);
  await action('instagram', 'reply-comment').execute(credential, { accountId: '456', commentId: '888', message: 'Thank you' }, env);
});

test('Messenger and Instagram DMs use authorized Page tokens and RESPONSE semantics', async () => {
  const platforms: unknown[] = [];
  mockGraph((url, init) => {
    assert.equal(url.pathname, '/v26.0/123/messages');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer page-token');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.messaging_type, 'RESPONSE');
    assert.deepEqual(body.recipient, { id: '789' });
    assert.deepEqual(body.message, { text: 'Reply' });
    platforms.push(body.platform);
    return Response.json({ message_id: 'message-id', recipient_id: '789' });
  });
  await action('facebook', 'reply-message').execute(credential, { pageId: '123', recipientId: '789', message: 'Reply' }, env);
  await action('instagram', 'reply-message').execute(credential, { accountId: '456', recipientId: '789', message: 'Reply' }, env);
  assert.deepEqual(platforms, [undefined, 'instagram']);
});

test('Instagram publishing hands a public image URL to Meta without fetching it and waits for its container', async () => {
  const steps: string[] = [];
  mockGraph((url, init) => {
    steps.push(url.pathname);
    if (url.pathname === '/v26.0/456/media') {
      assert.deepEqual(JSON.parse(String(init?.body)), { image_url: 'https://images.example/photo.jpg', caption: 'Caption' });
      return Response.json({ id: '999' });
    }
    if (url.pathname === '/v26.0/999') {
      assert.equal(url.searchParams.get('fields'), 'status_code');
      return Response.json({ status_code: 'FINISHED' });
    }
    assert.equal(url.pathname, '/v26.0/456/media_publish');
    assert.deepEqual(JSON.parse(String(init?.body)), { creation_id: '999' });
    return Response.json({ id: '1000' });
  });
  const result = await action('instagram', 'publish-image').execute(credential, { accountId: '456', imageUrl: 'https://images.example/photo.jpg', caption: 'Caption' }, env);
  assert.equal(result.items?.[0].mediaId, '1000');
  assert.deepEqual(steps, ['/v26.0/456/media', '/v26.0/999', '/v26.0/456/media_publish']);
});

test('Instagram does not publish a failed or already-published container', async () => {
  let writes = 0;
  mockGraph((_url, init) => {
    if (init?.method === 'POST') writes += 1;
    return Response.json({ status_code: 'PUBLISHED' });
  });
  await assert.rejects(action('instagram', 'publish-container').execute(credential, { accountId: '456', creationId: '999' }, env), /already published/);
  assert.equal(writes, 0);
});

test('Threads publishes text and replies through create then publish, preserving reply ID', async () => {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://graph.threads.com');
    assert.equal(url.searchParams.get('access_token'), 'user-token');
    assert.equal(init?.method, 'POST');
    requests.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
    return Response.json({ id: url.pathname.endsWith('threads_publish') ? '1000' : '999' });
  };
  await action('threads', 'reply-post').execute(credential, { threadId: '888', text: 'Reply' }, env);
  assert.deepEqual(requests, [
    { path: '/v1.0/me/threads', body: { media_type: 'TEXT', text: 'Reply', reply_to_id: '888' } },
    { path: '/v1.0/me/threads_publish', body: { creation_id: '999' } },
  ]);
});

test('Meta campaign creation is paused, records special categories, and omits spend activation', async () => {
  mockGraph((url, init) => {
    assert.equal(url.pathname, '/v26.0/act_123/campaigns');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.status, 'PAUSED');
    assert.equal(body.objective, 'OUTCOME_TRAFFIC');
    assert.deepEqual(body.special_ad_categories, ['HOUSING']);
    assert.equal(body.daily_budget, undefined);
    return Response.json({ id: '999' });
  });
  const result = await action('meta-business', 'create-campaign').execute(credential, { adAccountId: '123', name: 'Campaign', specialCategories: 'HOUSING' }, env);
  assert.equal(result.items?.[0].status, 'PAUSED');
});

test('Traffic ad set creation reads campaign eligibility and respects explicit budget units', async () => {
  mockGraph((url, init) => {
    if (url.pathname === '/v26.0/999') return Response.json({ id: '999', objective: 'OUTCOME_TRAFFIC', special_ad_categories: [] });
    assert.equal(url.pathname, '/v26.0/act_123/adsets');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.daily_budget, 1000);
    assert.equal(body.status, 'PAUSED');
    assert.equal(body.optimization_goal, 'LINK_CLICKS');
    assert.deepEqual(body.targeting.geo_locations.countries, ['US']);
    return Response.json({ id: '1000' });
  });
  const result = await action('meta-business', 'create-traffic-adset').execute(credential, { adAccountId: '123', campaignId: '999', name: 'Ad set', dailyBudget: '1000', country: 'us' }, env);
  assert.equal(result.items?.[0].dailyBudget, 1000);
});

test('Simple traffic ad set rejects special-category campaigns and fractional budgets without writing', async () => {
  let writes = 0;
  mockGraph((_url, init) => {
    if (init?.method === 'POST') writes += 1;
    return Response.json({ id: '999', objective: 'OUTCOME_TRAFFIC', special_ad_categories: ['HOUSING'] });
  });
  const values = { adAccountId: '123', campaignId: '999', name: 'Ad set', dailyBudget: '1000', country: 'US' };
  await assert.rejects(action('meta-business', 'create-traffic-adset').execute(credential, values, env), /without special ad categories/);
  await assert.rejects(action('meta-business', 'create-traffic-adset').execute(credential, { ...values, dailyBudget: '10.5' }, env), /integer/);
  assert.equal(writes, 0);
});

test('Meta creates a creative and paused ad, then only explicit activation enables ACTIVE', async () => {
  const bodies: Record<string, unknown>[] = [];
  mockGraph((url, init) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (url.pathname.endsWith('/adcreatives')) return Response.json({ id: '999' });
    if (url.pathname.endsWith('/ads')) return Response.json({ id: '1000' });
    assert.equal(url.pathname, '/v26.0/1000');
    return Response.json({ success: true });
  });
  await action('meta-business', 'create-post-creative').execute(credential, { adAccountId: '123', name: 'Creative', postId: '123_456' }, env);
  await action('meta-business', 'create-ad').execute(credential, { adAccountId: '123', name: 'Ad', adSetId: '888', creativeId: '999' }, env);
  await action('meta-business', 'set-status').execute(credential, { objectId: '1000', status: 'ACTIVE' }, env);
  assert.equal(bodies[0].object_story_id, '123_456');
  assert.equal(bodies[1].status, 'PAUSED');
  assert.deepEqual(bodies[1].creative, { creative_id: '999' });
  assert.deepEqual(bodies[2], { status: 'ACTIVE' });
});

test('Conversion upload requires explicit consent and hashes normalized email before sending', async () => {
  let writes = 0;
  const email = ' Customer@Example.com ';
  mockGraph((url, init) => {
    assert.equal(url.pathname, '/v26.0/123/events');
    const bodyText = String(init?.body);
    assert.equal(bodyText.toLowerCase().includes('customer@example.com'), false);
    const body = JSON.parse(bodyText);
    assert.equal(body.data[0].action_source, 'website');
    assert.equal(body.data[0].event_id, 'order-123');
    assert.deepEqual(body.data[0].user_data, { em: [createHash('sha256').update('customer@example.com').digest('hex')] });
    assert.deepEqual(body.data[0].custom_data, { value: 29.5, currency: 'USD' });
    assert.equal(body.test_event_code, 'TEST123');
    writes += 1;
    return Response.json({ events_received: 1, fbtrace_id: 'omit' });
  });
  const values = { pixelId: '123', eventName: 'Purchase', eventTime: new Date().toISOString(), eventId: 'order-123', sourceUrl: 'https://shop.example/receipt', email, value: '29.5', currency: 'usd', testEventCode: 'TEST123' };
  await assert.rejects(action('meta-business', 'upload-conversion').execute(credential, values, env), /permission or consent/);
  assert.equal(writes, 0);
  const result = await action('meta-business', 'upload-conversion').execute(credential, { ...values, consent: 'yes' }, env);
  assert.equal(result.items?.[0].eventsReceived, 1);
  assert.equal(JSON.stringify(result).toLowerCase().includes('customer'), false);
  assert.equal(writes, 1);
});

test('Conversion upload rejects stale events before any network request', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; return Response.json({}); };
  await assert.rejects(action('meta-business', 'upload-conversion').execute(credential, { consent: 'yes', eventTime: new Date(Date.now() - 8 * 86400000).toISOString() }, env), /last seven days/);
  assert.equal(requests, 0);
});

test('Insights results contain scalar metric rows and ad spend remains in account currency', async () => {
  mockGraph((url) => {
    if (url.pathname.endsWith('/act_123/insights')) {
      assert.equal(url.searchParams.get('time_increment'), '1');
      assert.equal(url.searchParams.get('level'), 'campaign');
      return Response.json({ data: [{ date_start: '2026-01-01', campaign_id: '999', campaign_name: 'Campaign', account_currency: 'USD', spend: '12.50', impressions: '1000', clicks: '12', cpc: '1.04', ctr: '1.2' }] });
    }
    assert.equal(url.searchParams.get('metric'), 'page_media_view');
    return Response.json({ data: [{ name: 'page_media_view', period: 'day', values: [{ value: 42, end_time: '2026-01-01' }] }] });
  });
  const insights = await action('facebook', 'page-insights').execute(credential, { pageId: '123' }, env);
  assert.deepEqual(insights.items, [{ metric: 'page_media_view', period: 'day', date: '2026-01-01', value: 42 }]);
  const spend = await action('meta-business', 'spend-insights').execute(credential, { adAccountId: '123' }, env);
  assert.equal(spend.items?.[0].spend, '12.50');
  assert.equal(spend.items?.[0].currency, 'USD');
});

test('Only independent publication actions are schedulable and all action IDs are unique per provider', () => {
  const ids = metaActions.map((item) => `${item.provider}/${item.definition.id}`);
  assert.equal(new Set(ids).size, ids.length);
  for (const item of metaActions) {
    if (item.definition.schedulable) {
      assert.equal(item.definition.group, 'publishing');
      assert.equal(item.definition.kind, 'write');
    }
  }
  assert.equal(action('meta-business', 'set-status').definition.schedulable, undefined);
  assert.equal(action('meta-business', 'upload-conversion').definition.schedulable, undefined);
});
