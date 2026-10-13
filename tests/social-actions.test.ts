import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { socialActions } from '../server/actions-social';
import { socialAdapters } from '../server/providers-social';
import { ProviderError } from '../server/provider-types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'private-access-token' };
const env = { REDDIT_USER_AGENT: 'web:connector-test:0.1 (by /u/test_user)', LINKEDIN_API_VERSION: '202601' };
function get(provider: string, id: string) {
  const result = socialActions.find((item) => item.provider === provider && item.definition.id === id);
  assert.ok(result, `${provider}/${id} exists`);
  return result;
}

test('only publishing actions are schedulable; unsupported inbox and analytics endpoints are absent', () => {
  for (const current of socialActions) {
    assert.equal(Boolean(current.definition.schedulable), current.definition.id === 'publish');
    if (current.definition.schedulable) assert.equal(current.definition.kind, 'write');
  }
  assert.equal(socialActions.some((item) => item.provider === 'tiktok' && item.definition.group === 'inbox'), false);
  assert.equal(socialActions.some((item) => item.provider === 'linkedin' && ['analytics', 'messages'].includes(item.definition.id)), false);
});

test('X replies retain the exact parent relationship and send credentials only in the header', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.x.com/2/tweets');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private-access-token');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), { text: 'An explicit reply', reply: { in_reply_to_tweet_id: '123' } });
    return Response.json({ data: { id: '456' } });
  };
  assert.deepEqual((await get('x', 'reply').execute(credential, { postId: '123', text: 'An explicit reply' }, env)).items, [{ id: '456' }]);
});

test('X DM recipients are numeric path components and the official response must confirm an event', async () => {
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.x.com/2/dm_conversations/with/123/messages');
    assert.deepEqual(JSON.parse(String(init?.body)), { text: 'Hello' });
    return Response.json({ data: { dm_event_id: '456', dm_conversation_id: '123-789' } });
  };
  await assert.rejects(get('x', 'send-message').execute(credential, { participantId: '123/../../evil', text: 'Hello' }, env), ProviderError);
  assert.equal(calls, 0);
  const result = await get('x', 'send-message').execute(credential, { participantId: '123', text: 'Hello' }, env);
  assert.equal(result.items?.[0].id, '456');
  globalThis.fetch = async () => Response.json({ data: {} });
  await assert.rejects(get('x', 'send-message').execute(credential, { participantId: '123', text: 'Hello' }, env), /did not confirm/);
});

test('X recent replies are scoped to the requested conversation and empty result sets are supported', async () => {
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, '/2/tweets/search/recent');
    assert.equal(parsed.searchParams.get('query'), 'conversation_id:123');
    return Response.json({ meta: { result_count: 0 } });
  };
  assert.deepEqual((await get('x', 'comments').execute(credential, { postId: '123' }, env)).items, []);
});

const tiktokValues = { videoUrl: 'https://verified.example/video.mp4', title: 'My video', privacy: 'SELF_ONLY', allowComments: 'yes', allowDuet: 'no', allowStitch: 'no', brandOrganic: 'no', brandContent: 'no', aiGenerated: 'yes', consent: 'I agree' };
test('TikTok verifies creator options before a URL-based submission and does not claim it is published', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(new URL(String(url)).hostname, 'open.tiktokapis.com');
    if (String(url).includes('creator_info')) return Response.json({ error: { code: 'ok' }, data: { privacy_level_options: ['SELF_ONLY'], comment_disabled: true } });
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.source_info, { source: 'PULL_FROM_URL', video_url: tiktokValues.videoUrl });
    assert.equal(body.post_info.disable_comment, true);
    assert.equal(body.post_info.is_aigc, true);
    assert.equal(body.post_info.privacy_level, 'SELF_ONLY');
    return Response.json({ error: { code: 'ok' }, data: { publish_id: 'publish-one' } });
  };
  const result = await get('tiktok', 'publish').execute(credential, tiktokValues, env);
  assert.equal(calls.length, 2);
  assert.match(result.summary, /accepted the video submission/);
  assert.deepEqual(result.items, [{ publishId: 'publish-one' }]);
});

test('TikTok refuses a privacy level unavailable to the creator and validates all consent choices', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: { code: 'ok' }, data: { privacy_level_options: ['SELF_ONLY'] } }); };
  await assert.rejects(get('tiktok', 'publish').execute(credential, { ...tiktokValues, consent: '' }, env), /Confirm TikTok/);
  assert.equal(calls, 0);
  await assert.rejects(get('tiktok', 'publish').execute(credential, { ...tiktokValues, privacy: 'PUBLIC_TO_EVERYONE' }, env), /cannot use that privacy/);
  assert.equal(calls, 1);
});

test('TikTok HTTP 200 error envelopes never become successful publication or analytics results', async () => {
  globalThis.fetch = async () => Response.json({ error: { code: 'scope_not_authorized', message: 'private-access-token' }, data: { publish_id: 'fake' } });
  await assert.rejects(get('tiktok', 'publish-status').execute(credential, { publishId: 'fake' }, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message.includes('private-access-token'), false);
    return true;
  });
});

test('LinkedIn posts derive the actor from the connected member and require a created resource ID', async () => {
  const calls: string[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'member-123' });
    assert.equal(url, 'https://api.linkedin.com/rest/posts');
    assert.equal(new Headers(init?.headers).get('LinkedIn-Version'), env.LINKEDIN_API_VERSION);
    assert.equal(new Headers(init?.headers).get('X-Restli-Protocol-Version'), '2.0.0');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.author, 'urn:li:person:member-123');
    assert.equal(body.commentary, 'Hello LinkedIn');
    assert.equal(body.lifecycleState, 'PUBLISHED');
    return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:123' } });
  };
  assert.deepEqual((await get('linkedin', 'publish').execute(credential, { text: 'Hello LinkedIn' }, env)).items, [{ id: 'urn:li:share:123' }]);
  assert.equal(calls.length, 2);
});

test('LinkedIn restricted read permission is opt-in and comment replies preserve the parent URN', async () => {
  const adapter = socialAdapters.find((item) => item.definition.id === 'linkedin')!;
  const input = { redirectUri: 'https://connector.example/callback', state: 'state', codeVerifier: 'verifier', env: { LINKEDIN_CLIENT_ID: 'client' } };
  assert.equal(new URL(adapter.authorize!(input)).searchParams.get('scope'), 'openid profile w_member_social');
  assert.equal(new URL(adapter.authorize!({ ...input, env: { ...input.env, LINKEDIN_ENABLE_MEMBER_READ: 'true' } })).searchParams.get('scope'), 'openid profile w_member_social r_member_social');
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    if (String(url).endsWith('/userinfo')) return Response.json({ sub: 'member' });
    const body = JSON.parse(String(init?.body));
    assert.equal(body.object, 'urn:li:activity:123');
    assert.equal(body.parentComment, 'urn:li:comment:(urn:li:activity:123,456)');
    assert.equal(body.actor, 'urn:li:person:member');
    return Response.json({ id: '789' });
  };
  await assert.rejects(get('linkedin', 'comments').execute(credential, { postUrn: 'urn:li:activity:123' }, env), /restricted|approved/);
  assert.equal(calls, 0);
  await get('linkedin', 'reply').execute(credential, { postUrn: 'urn:li:activity:123', parentCommentUrn: 'urn:li:comment:(urn:li:activity:123,456)', text: 'Reply' }, env);
  assert.equal(calls, 2);
});

test('Reddit posts encode content and correctly parse the application-level result', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://oauth.reddit.com/api/submit');
    assert.equal(new Headers(init?.headers).get('user-agent'), env.REDDIT_USER_AGENT);
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('kind'), 'self');
    assert.equal(form.get('sr'), 'test');
    assert.equal(form.get('api_type'), 'json');
    assert.equal(form.get('text'), 'literal & text');
    return Response.json({ json: { errors: [], data: { name: 't3_abc' } } });
  };
  assert.deepEqual((await get('reddit', 'publish').execute(credential, { subreddit: 'test', title: 'Title', postType: 'text', text: 'literal & text' }, env)).items, [{ id: 't3_abc' }]);
  globalThis.fetch = async () => Response.json({ json: { errors: [['SUBREDDIT_NOTALLOWED', 'private-access-token', 'sr']], data: { name: 'fake' } } });
  await assert.rejects(get('reddit', 'publish').execute(credential, { subreddit: 'test', title: 'Title', postType: 'text', text: 'Body' }, env), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message.includes('private-access-token'), false);
    return true;
  });
});

test('Reddit public comments and private message replies use different parent fullname types', async () => {
  globalThis.fetch = async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    assert.equal(form.get('thing_id'), 't4_abc');
    return Response.json({ json: { errors: [], data: {} } });
  };
  await assert.rejects(get('reddit', 'reply').execute(credential, { parentId: 't4_abc', text: 'Reply' }, env), /t3_ post or t1_/);
  await get('reddit', 'reply-message').execute(credential, { messageId: 't4_abc', text: 'Reply' }, env);
});

test('Pinterest sends image URLs only to its official Pin API and validates HTTPS first', async () => {
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'https://api.pinterest.com/v5/pins');
    assert.deepEqual(JSON.parse(String(init?.body)).media_source, { source_type: 'image_url', url: 'https://images.example/photo.jpg' });
    return Response.json({ id: '1234' });
  };
  await assert.rejects(get('pinterest', 'publish').execute(credential, { boardId: '123', title: 'Pin', imageUrl: 'http://images.example/photo.jpg' }, env), /HTTPS/);
  assert.equal(requests, 0);
  await get('pinterest', 'publish').execute(credential, { boardId: '123', title: 'Pin', imageUrl: 'https://images.example/photo.jpg' }, env);
  assert.equal(requests, 1);
});

test('Pinterest analytics preserves provider metrics and rejects invalid or reversed dates without requests', async () => {
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    const parsed = new URL(String(url));
    assert.equal(parsed.pathname, '/v5/pins/123/analytics');
    assert.equal(parsed.searchParams.get('start_date'), '2026-10-01');
    return Response.json({ all: { summary_metrics: { IMPRESSION: 12, SAVE: 3 } } });
  };
  for (const dates of [{ startDate: '2026-02-30', endDate: '2026-10-03' }, { startDate: '2026-10-03', endDate: '2026-10-01' }]) {
    await assert.rejects(get('pinterest', 'analytics').execute(credential, { pinId: '123', ...dates }, env), ProviderError);
  }
  assert.equal(requests, 0);
  assert.deepEqual((await get('pinterest', 'analytics').execute(credential, { pinId: '123', startDate: '2026-10-01', endDate: '2026-10-03' }, env)).items, [{ segment: 'all', IMPRESSION: 12, SAVE: 3 }]);
});

test('WordPress writes target only official numeric site/comment paths and retain moderation status', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://public-api.wordpress.com/rest/v1.1/sites/123/comments/456/replies/new');
    assert.equal(new URLSearchParams(String(init?.body)).get('content'), 'A reply');
    return Response.json({ ID: 789, status: 'unapproved' });
  };
  const result = await get('wordpress', 'reply').execute(credential, { siteId: '123', commentId: '456', text: 'A reply' }, env);
  assert.deepEqual(result.items, [{ id: '789', status: 'unapproved' }]);
  await assert.rejects(get('wordpress', 'reply').execute(credential, { siteId: 'https://attacker.example', commentId: '456', text: 'A reply' }, env), /numeric platform ID/);
});

test('provider error bodies and thrown network errors cannot leak secrets', async () => {
  const run = () => get('x', 'publish').execute(credential, { text: 'Hello' }, env);
  for (const response of [async () => Response.json({ error: 'private-access-token' }, { status: 403 }), async () => { throw new Error('private-access-token'); }, async () => Response.json({ errors: [{ detail: 'private-access-token' }], data: { id: '123' } })]) {
    globalThis.fetch = response;
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes('private-access-token'), false);
      return true;
    });
  }
});
