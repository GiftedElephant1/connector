import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { snapchatActions } from '../server/actions-snapchat';
import { ProviderError } from '../server/provider-types';
import type { ActionValues } from '../server/action-types';

const profileId = '76da494b-76bc-4bbb-bb27-c5a66fb0d1ab';
const mediaId = 'abed133c-0b1b-3676-8808-3dd6cc164909';
const organizationId = '40d6719b-da09-410b-9185-0cc9c0dfed1d';
const api = 'https://businessapi.snapchat.com';
const uploadPath = `/us/v1/public_profiles/${profileId}/media/${mediaId}/multipart-upload`;
const token = 'private-profile-access-token';
const png = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
const mp4 = Buffer.from('000000186674797069736f6d0000000069736f6d6d703432', 'hex');
const dataUrl = (data: Buffer, type = 'image/png') => `data:${type};base64,${data.toString('base64')}`;
const run = (id: string, values: ActionValues) => snapchatActions.find(action => action.definition.id === id)!.execute({ accessToken: token }, values, {});
const story = { profileId, name: 'Brand Story', media: dataUrl(png), link: 'https://vectrepay.com/' };

function uploadMock(t: TestContext, options: { kind?: 'story' | 'spotlight'; failureAt?: string; hostilePath?: string } = {}) {
  const kind = options.kind || 'story', bytes = kind === 'story' ? png : mp4;
  const calls: string[] = [];
  let key: Buffer, iv: Buffer;
  t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(new URL(url).origin, api);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${token}`);
    const path = new URL(url).pathname;
    if (path.endsWith('/media')) {
      calls.push('create');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.type, kind === 'story' ? 'IMAGE' : 'VIDEO');
      assert.equal(body.name, story.name);
      key = Buffer.from(body.key, 'base64'); iv = Buffer.from(body.iv, 'base64');
      assert.equal(key.length, 32); assert.equal(iv.length, 16);
      if (options.failureAt === 'create') return Response.json({ request_status: 'ERROR', debug_message: token });
      return Response.json({ request_status: 'SUCCESS', media_id: mediaId, add_path: options.hostilePath || uploadPath, finalize_path: uploadPath });
    }
    if (path.endsWith('/multipart-upload')) {
      assert.equal(path, uploadPath);
      assert.ok(init?.body instanceof FormData);
      const action = String(init.body.get('action'));
      calls.push(action);
      if (action === 'ADD') {
        assert.equal(init.body.get('part_number'), '1');
        const file = init.body.get('file');
        assert.ok(file instanceof Blob);
        const encrypted = Buffer.from(await file.arrayBuffer());
        assert.notDeepEqual(encrypted, bytes);
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        assert.deepEqual(Buffer.concat([decipher.update(encrypted), decipher.final()]), bytes);
      } else {
        assert.equal(action, 'FINALIZE');
        assert.equal(init.body.has('file'), false);
      }
      return Response.json({ request_status: options.failureAt === action ? 'ERROR' : 'SUCCESS', debug_message: token });
    }
    calls.push('publish');
    assert.equal(path, `/v1/public_profiles/${profileId}/${kind === 'story' ? 'stories' : 'spotlights'}`);
    const body = JSON.parse(String(init?.body));
    assert.equal(body.media_id, mediaId);
    assert.equal(body.link, 'https://vectrepay.com/');
    assert.equal(body.key, undefined); assert.equal(body.iv, undefined);
    if (kind === 'spotlight') { assert.equal(body.locale, 'en_US'); assert.equal(body.description, 'Payment tips #smallbusiness'); }
    return Response.json({ request_status: options.failureAt === 'publish' ? 'ERROR' : 'SUCCESS', spotlight_id: 'spotlight_123', debug_message: token, request_id: 'request-123' });
  });
  return calls;
}

test('Snapchat Story publication encrypts exact local bytes, completes upload, then posts', async t => {
  const calls = uploadMock(t);
  const result = await run('publish-story', story);
  assert.deepEqual(calls, ['create', 'ADD', 'FINALIZE', 'publish']);
  assert.match(result.summary, /accepted.*confirm its visibility/);
  assert.equal(result.items?.[0].status, 'accepted');
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(JSON.stringify(result).includes(story.media), false);
  assert.ok(snapchatActions.find(action => action.definition.id === 'publish-story')?.definition.schedulable, 'scheduled execution uploads fresh media rather than an expired media ID');
});

test('Snapchat Spotlight publication uses video, caption and locale and returns its accepted identifier', async t => {
  const calls = uploadMock(t, { kind: 'spotlight' });
  const result = await run('publish-spotlight', { ...story, media: dataUrl(mp4, 'video/mp4'), locale: 'en_US', description: 'Payment tips #smallbusiness' });
  assert.deepEqual(calls, ['create', 'ADD', 'FINALIZE', 'publish']);
  assert.equal(result.items?.[0].id, 'spotlight_123');
  assert.match(result.summary, /processing and visibility/);
});

test('Snapchat never sends encrypted media or bearer credentials to an untrusted returned upload destination', async t => {
  for (const hostilePath of [
    'https://evil.example/upload', '//evil.example/upload',
    uploadPath.replace(profileId, organizationId), uploadPath.replace(mediaId, organizationId),
    `${uploadPath}?redirect=https://evil.example`, `${uploadPath}#fragment`, `/us/../${uploadPath.slice(1)}`,
  ]) {
    const calls = uploadMock(t, { hostilePath });
    await assert.rejects(run('publish-story', story), /unexpected media upload destination/);
    assert.deepEqual(calls, ['create']);
    t.mock.restoreAll();
  }
});

test('Snapchat stops before publishing when any media stage fails and redacts error bodies', async t => {
  for (const failureAt of ['create', 'ADD', 'FINALIZE', 'publish']) {
    const calls = uploadMock(t, { failureAt });
    await assert.rejects(run('publish-story', story), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(token), false);
      return true;
    });
    const sequence = ['create', 'ADD', 'FINALIZE', 'publish'];
    assert.deepEqual(calls, sequence.slice(0, sequence.indexOf(failureAt) + 1));
    t.mock.restoreAll();
  }
});

test('Snapchat rejects malformed media, profile paths and captions before creating remote media', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected request'); });
  for (const values of [
    { ...story, profileId: '../other' },
    { ...story, media: 'https://example.com/video.mp4' },
    { ...story, media: dataUrl(Buffer.from('invalid png')) },
    { ...story, media: `${story.media} ` },
    { ...story, media: 'data:image/png;base64,aGVsbG8' },
    { ...story, media: dataUrl(Buffer.alloc(20 * 1024 * 1024 + 1)) },
    { ...story, name: 'two\nlines' },
    { ...story, link: 'https://user:password@vectrepay.com/' },
  ]) await assert.rejects(run('publish-story', values), ProviderError);
  await assert.rejects(run('publish-spotlight', { ...story, locale: 'en_US' }), /requires an MP4 video/);
  await assert.rejects(run('publish-spotlight', { ...story, media: dataUrl(mp4, 'video/mp4'), locale: 'en_US', description: 'x'.repeat(161) }), /at most 160/);
  await assert.rejects(run('publish-spotlight', { ...story, media: dataUrl(mp4, 'video/mp4'), locale: '../en_US' }), /language_country/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('Snapchat treats in-progress and partial publication responses as uncertain', async t => {
  for (const response of [
    { request_status: 'ERROR', error_code: 'MEDIA_POSTING_ALREADY_IN_PROGRESS' },
    { request_status: 'PARTIAL', debug_message: token },
  ]) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(response));
    await assert.rejects(run('publish-story', story), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 502);
      assert.equal(error.message.includes(token), false);
      return true;
    });
    t.mock.restoreAll();
  }
});

test('Snapchat content listing binds the requested profile and returns a cursor without following arbitrary next links', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    const parsed = new URL(url);
    assert.equal(parsed.origin + parsed.pathname, `${api}/v1/public_profiles/${profileId}/stories`);
    assert.equal(parsed.searchParams.get('limit'), '100');
    assert.equal(parsed.searchParams.get('cursor'), 'cursor+/=&');
    return Response.json({ request_status: 'SUCCESS', stories: [{ sub_request_status: 'SUCCESS', story: { id: 'story-1', profile_id: profileId, created_at: '2026-10-24T00:00:00Z' } }], paging: { next_page_id: 'next-cursor', next_link: 'https://untrusted.example/follow-me' } });
  });
  const result = await run('list-stories', { profileId, cursor: 'cursor+/=&' });
  assert.equal(result.items?.[0].id, 'story-1');
  assert.equal(result.items?.[1].nextCursor, 'next-cursor');
  assert.equal(calls, 1);
});

test('Snapchat listings reject partial and wrong-profile records instead of returning success', async t => {
  let body: unknown;
  t.mock.method(globalThis, 'fetch', async () => Response.json(body));
  for (const spotlight of [
    { sub_request_status: 'ERROR', spotlight: { id: 'spot-1', profile_id: profileId } },
    { sub_request_status: 'SUCCESS', spotlight: { id: 'spot-1', profile_id: organizationId } },
  ]) {
    body = { request_status: 'SUCCESS', spotlights: [spotlight] };
    await assert.rejects(run('list-spotlights', { profileId }), /did not confirm/);
  }
  body = { request_status: 'SUCCESS', public_profiles: [{ sub_request_status: 'SUCCESS', public_profile: { id: profileId, display_name: 'Vectre Pay' } }] };
  assert.equal((await run('list-profiles', { organizationId })).items?.[0].id, profileId);
});
