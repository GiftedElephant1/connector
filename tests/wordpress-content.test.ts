import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWordpressActions } from '../server/actions-wordpress';
import { createWordpressAdapters } from '../server/providers-wordpress';
import type { Credential } from '../server/provider-types';
import { ProviderError } from '../server/provider-types';

const credential: Credential = { accessToken: 'abcd efgh ijkl mnop qrst uvwx', fields: { siteUrl: 'https://blog.example/wordpress', username: 'editor' } };
const content = (type: 'post' | 'page', status = 'draft', extra = {}) => ({
  id: 42, type, status, title: { raw: 'Editable & title', rendered: 'Editable &amp; title' },
  content: { raw: '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->', rendered: '<p>Hello</p>' },
  ...(type === 'post' ? { excerpt: { raw: 'An excerpt', rendered: '<p>An excerpt</p>' } } : { parent: 0 }),
  slug: 'editable-title', link: `https://blog.example/wordpress/${type}/42`, modified_gmt: '2026-10-14T12:00:00',
  ...extra,
});
const find = (id: string, request: Parameters<typeof createWordpressActions>[0]) => {
  const found = createWordpressActions(request).find(action => action.definition.id === id);
  assert.ok(found, id);
  return found;
};

test('self-hosted WordPress verifies the authenticated user read-only and reports actual editing capabilities', async () => {
  let calls = 0;
  const [provider] = createWordpressAdapters(async (provided, path, init) => {
    calls++;
    assert.equal(provided, credential);
    assert.equal(path, '/wp/v2/users/me?context=edit');
    assert.equal(init?.method ?? 'GET', 'GET');
    return { id: 7, name: 'Sam Editor', email: 'private@example.com', capabilities: { edit_posts: true, publish_posts: true, edit_pages: true, publish_pages: false, edit_others_pages: true }, private_field: 'omit' };
  });
  assert.equal(provider.definition.id, 'wordpress-self-hosted');
  assert.equal(provider.definition.authType, 'api_key');
  assert.deepEqual(provider.requiredEnv, []);
  assert.deepEqual(provider.definition.credentialFields?.map(field => field.name), ['siteUrl', 'username']);
  const result = await provider.verify(credential, {});
  assert.equal(calls, 1);
  assert.equal(result.accountId, '7');
  assert.equal(result.accountName, 'Sam Editor · blog.example');
  assert.ok(result.resources.some(resource => resource.type === 'website' && resource.id === 'https://blog.example/wordpress'));
  assert.ok(result.resources.some(resource => resource.id === 'edit_pages'));
  assert.ok(!result.resources.some(resource => resource.id === 'publish_pages'));
  assert.ok(!JSON.stringify(result).includes('private@example.com'));
});

test('WordPress verification rejects subscriber-only, malformed, and error profiles without reflecting upstream data', async () => {
  const profiles = [
    { id: 7, name: 'Subscriber', capabilities: { read: true } },
    { id: 0, name: 'Bad', capabilities: { edit_posts: true } },
    { id: 7, name: 'Bad' },
    { code: 'forbidden', message: credential.accessToken },
  ];
  for (const body of profiles) {
    const [provider] = createWordpressAdapters(async () => body);
    await assert.rejects(provider.verify(credential, {}), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(credential.accessToken), false);
      return true;
    });
  }
  const [author] = createWordpressAdapters(async () => ({ id: 7, name: 'Author', capabilities: { edit_posts: true } }));
  assert.equal((await author.verify(credential, {})).resources.some(resource => resource.id === 'edit_pages'), false);
});

for (const type of ['post', 'page'] as const) {
  test(`WordPress creates a ${type} draft unless another non-public status is explicit`, async () => {
    const action = find(`create-${type}`, async (provided, path, init) => {
      assert.equal(provided, credential);
      assert.equal(path, `/wp/v2/${type}s`);
      assert.equal(init?.method, 'POST');
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      assert.deepEqual(JSON.parse(String(init?.body)), { title: 'New title', content: '<p>New content</p>', status: 'draft' });
      return content(type);
    });
    const result = await action.execute(credential, { title: 'New title', content: '<p>New content</p>' }, {});
    assert.equal(result.items?.[0].status, 'draft');
    assert.equal(Boolean(action.definition.schedulable), false);
    await assert.rejects(action.execute(credential, { title: 'New title', content: 'Body', status: 'publish' }, {}), /supported WordPress content status/);
  });

  test(`WordPress explicit ${type} publication can be scheduled and reports the returned status`, async () => {
    const action = find(type === 'post' ? 'publish' : 'publish-page', async (_provided, path, init) => {
      assert.equal(path, `/wp/v2/${type}s`);
      assert.deepEqual(JSON.parse(String(init?.body)), { title: 'Publish me', content: 'Public content', status: 'publish' });
      return content(type, 'pending');
    });
    assert.equal(action.definition.schedulable, true);
    const result = await action.execute(credential, { title: 'Publish me', content: 'Public content' }, {});
    assert.equal(result.items?.[0].status, 'pending');
    assert.match(result.summary, /Returned status: pending/);
    assert.equal(result.link, `https://blog.example/wordpress/${type}/42`);
  });

  test(`WordPress ${type} edits preserve omitted title, content, slug, and publication status`, async () => {
    const action = find(`update-${type}`, async (_provided, path, init) => {
      assert.equal(path, `/wp/v2/${type}s/42`);
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { content: '<p>Only this changes</p>' });
      return content(type, 'publish');
    });
    const result = await action.execute(credential, { [`${type}Id`]: '42', content: '<p>Only this changes</p>', title: '', slug: '', status: '' }, {});
    assert.equal(result.items?.[0].id, '42');
    assert.equal(result.items?.[0].status, 'publish');
    assert.equal(Boolean(action.definition.schedulable), false);
  });

  test(`WordPress ${type} source reads retain complete unrendered markup for AI edits`, async () => {
    const source = `<!-- wp:html -->${'markup '.repeat(1200)}<!-- /wp:html -->`;
    const action = find(`read-${type}`, async (_provided, path, init) => {
      assert.equal(path, `/wp/v2/${type}s/42?context=edit`);
      assert.equal(init?.method ?? 'GET', 'GET');
      return content(type, 'draft', { content: { raw: source, rendered: 'Shorter rendered content' } });
    });
    const result = await action.execute(credential, { [`${type}Id`]: '42' }, {});
    assert.equal(result.items?.[0].content, source);
    assert.equal(result.items?.[0].title, 'Editable & title');
    if (type === 'page') assert.equal('excerpt' in result.items![0], false);
    const missingSource = find(`read-${type}`, async () => content(type, 'draft', { content: { rendered: 'Rendered only' } }));
    await assert.rejects(missingSource.execute(credential, { [`${type}Id`]: '42' }, {}), /unexpected content response/);
  });

  test(`WordPress lists ${type}s with edit context, explicit draft filters, and continuation pages`, async () => {
    const action = find(`${type}s`, async (_provided, path, init) => {
      const url = new URL(path, 'https://unused.example');
      assert.equal(url.pathname, `/wp/v2/${type}s`);
      assert.equal(url.searchParams.get('context'), 'edit');
      assert.equal(url.searchParams.get('per_page'), '25');
      assert.equal(url.searchParams.get('page'), '2');
      assert.equal(url.searchParams.get('status'), 'draft');
      assert.equal(init?.method ?? 'GET', 'GET');
      return [content(type)];
    });
    const result = await action.execute(credential, { status: 'draft', page: '2' }, {});
    assert.equal(result.items?.length, 1);
    assert.equal(result.items?.[0].content, undefined);
    const empty = find(`${type}s`, async () => []);
    assert.deepEqual((await empty.execute(credential, {}, {})).items, []);
  });
}

test('WordPress page parenting accepts top-level zero and never sends page-only fields to posts', async () => {
  const pages = find('update-page', async (_provided, path, init) => {
    assert.equal(path, '/wp/v2/pages/42');
    assert.deepEqual(JSON.parse(String(init?.body)), { parent: 0, status: 'publish' });
    return content('page', 'publish');
  });
  await pages.execute(credential, { pageId: '42', parentId: '0', status: 'publish' }, {});
  const actions = createWordpressActions(async () => ({}));
  assert.ok(actions.filter(action => ['create-post', 'update-post', 'publish'].includes(action.definition.id)).every(action => !action.definition.fields.some(field => field.name === 'parentId')));
  assert.ok(actions.filter(action => ['create-page', 'update-page', 'publish-page'].includes(action.definition.id)).every(action => !action.definition.fields.some(field => field.name === 'excerpt')));
});

test('WordPress refuses invalid IDs, empty edits, malformed statuses, and oversized content before HTTP', async () => {
  let calls = 0;
  const request = async () => { calls++; return content('post'); };
  for (const postId of ['0', '-1', '1.5', '../users', '42?force=true', '9007199254740992', 'https://evil.example']) {
    await assert.rejects(find('read-post', request).execute(credential, { postId }, {}), /WordPress ID/);
  }
  await assert.rejects(find('update-post', request).execute(credential, { postId: '42' }, {}), /at least one field/);
  await assert.rejects(find('create-post', request).execute(credential, { title: 'Title', content: 'x'.repeat(50_001) }, {}), /at most 50,000/);
  await assert.rejects(find('update-page', request).execute(credential, { pageId: '42', parentId: '-2' }, {}), /WordPress ID/);
  await assert.rejects(find('update-post', request).execute(credential, { postId: '42', status: 'trash' }, {}), /supported WordPress/);
  for (const page of ['0', '-1', '1.5', '1&status=private']) await assert.rejects(find('posts', request).execute(credential, { page }, {}), /positive whole number/);
  assert.equal(calls, 0);
});

test('WordPress write results must confirm an ID, content type, and status without reflecting API errors', async () => {
  const invalid = [{}, { code: 'bad', message: credential.accessToken }, content('page'), content('post', 'unknown'), content('post', 'draft', { id: 0 })];
  for (const body of invalid) {
    await assert.rejects(find('publish', async () => body).execute(credential, { title: 'Title', content: 'Body' }, {}), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.ok(!error.message.includes(credential.accessToken));
      return true;
    });
  }
  const action = find('publish', async () => content('post', 'publish', { link: 'https://other.example/login' }));
  assert.equal((await action.execute(credential, { title: 'Title', content: 'Body' }, {})).link, undefined);
});

test('WordPress reads and edits must return the exact content ID requested', async () => {
  const response = async () => content('page', 'draft', { id: 99 });
  await assert.rejects(find('read-page', response).execute(credential, { pageId: '42' }, {}), /unexpected content response/);
  await assert.rejects(find('update-page', response).execute(credential, { pageId: '42', title: 'Changed' }, {}), /unexpected content response/);
});
