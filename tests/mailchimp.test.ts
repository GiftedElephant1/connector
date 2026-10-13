import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mailchimpAdapters, mailchimpConnection } from '../server/providers-mailchimp.ts';
import { mailchimpActions } from '../server/actions-mailchimp.ts';
import { ProviderError } from '../server/provider-types.ts';
import { Pipeline } from '../server/pipeline.ts';
import { Store } from '../server/store.ts';
import { validateValues } from '../server/actions.ts';
import type { ActionValues } from '../server/action-types.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
// Synthetic credentials for mocked requests; never use a real provider key here.
const syntheticKey = '0123456789abcdef'.repeat(2);
const credential = { accessToken: `${syntheticKey}-us21` };
const adapter = mailchimpAdapters[0];
const action = (id: string) => {
  const found = mailchimpActions.find((item) => item.definition.id === id);
  assert.ok(found);
  return found;
};
const draft = { id: 'c123456789', type: 'regular', status: 'save', recipients: { list_id: 'a123456789', list_name: 'Newsletter', recipient_count: 20 }, settings: { title: 'October newsletter', subject_line: 'Our news', from_name: 'Example', reply_to: 'news@example.com' } };
const createValues = { audienceId: 'a123456789', title: 'October newsletter', subject: 'Our news', fromName: 'Example', replyTo: 'news@example.com' };
const campaignValues = { campaignId: draft.id, audienceId: draft.recipients.list_id };
function url(input: unknown, init?: RequestInit) {
  const value = new URL(String(input));
  assert.equal(value.origin, 'https://us21.api.mailchimp.com');
  assert.equal(value.username, '');
  assert.equal(value.password, '');
  assert.equal(new Headers(init?.headers).get('authorization'), `Basic ${Buffer.from(`connector:${credential.accessToken}`).toString('base64')}`);
  assert.equal(init?.redirect, 'error');
  assert.ok(init?.signal);
  return value;
}

test('Mailchimp verifies the account on its official data center with Basic auth and only returns selected profile fields', async () => {
  globalThis.fetch = async (input, init) => {
    const target = url(input, init);
    assert.equal(target.pathname, '/3.0/');
    assert.equal(target.searchParams.get('fields'), 'account_id,account_name');
    assert.equal(init?.method, undefined);
    return Response.json({ account_id: 'account123', account_name: 'Example business', api_key: 'private-upstream', contact: { email: 'private@example.com' } });
  };
  assert.deepEqual(await adapter.verify(credential, {}), { accountId: 'account123', accountName: 'Example business', resources: [] });
  assert.equal(adapter.definition.category, 'communications');
  assert.equal(adapter.definition.authType, 'api_key');
  assert.deepEqual(adapter.requiredEnv, []);
});

test('Mailchimp rejects invalid credentials and host injection before issuing any request', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const accessToken of [
    'short-us21', syntheticKey,
    `${credential.accessToken}.evil.example`, `${credential.accessToken}@127.0.0.1`,
    `${credential.accessToken}/../me`, `${credential.accessToken}?x=y`, `${credential.accessToken}\r\nX: y`,
    `${syntheticKey}-us0`, `${syntheticKey}-eu21`,
  ]) await assert.rejects(adapter.verify({ accessToken }, {}), ProviderError);
  assert.equal(calls, 0);
  assert.equal(mailchimpConnection({ accessToken: credential.accessToken.toUpperCase() }).origin, 'https://us21.api.mailchimp.com/3.0');
});

test('Mailchimp profile rejects malformed success responses and does not reveal upstream error bodies', async () => {
  for (const body of [{ account_id: 123, account_name: 'Example' }, { account_id: 'id' }, { account_id: '', account_name: 'Example' }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(adapter.verify(credential, {}), /invalid account profile/);
  }
  globalThis.fetch = async () => Response.json({ detail: `rejected ${credential.accessToken}` }, { status: 401 });
  await assert.rejects(adapter.verify(credential, {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, 401);
    assert.equal(error.message.includes(credential.accessToken), false);
    return true;
  });
});

test('Mailchimp audience pages contain counts without subscriber data and provide a usable continuation offset', async () => {
  globalThis.fetch = async (input, init) => {
    const target = url(input, init);
    assert.equal(target.pathname, '/3.0/lists');
    assert.equal(target.searchParams.get('count'), '2');
    assert.equal(target.searchParams.get('offset'), '1');
    assert.equal(init?.method, undefined);
    return Response.json({ total_items: 4, lists: [{ id: 'audience2', name: 'Second', stats: { member_count: 20 }, contacts: ['private@example.com'] }, { id: 'audience3', name: 'Third', stats: { member_count: 0 } }] });
  };
  const result = await action('list-audiences').execute(credential, { limit: '2', offset: '1' }, {});
  assert.deepEqual(result.items?.[0], { rowType: 'pagination', returned: 2, total: 4, hasMore: true, nextOffset: 3 });
  assert.deepEqual(result.items?.[1], { audienceId: 'audience2', name: 'Second', subscribedContacts: 20 });
  assert.equal(JSON.stringify(result).includes('private@example.com'), false);
});

test('Mailchimp campaign list and details expose recipient audience and status through read endpoints', async () => {
  globalThis.fetch = async (input, init) => {
    const target = url(input, init);
    assert.equal(init?.method, undefined);
    if (target.pathname === '/3.0/campaigns') {
      assert.equal(target.searchParams.get('type'), 'regular');
      assert.equal(target.searchParams.get('sort_dir'), 'DESC');
      assert.match(target.searchParams.get('fields')!, /campaigns\.recipients\.list_id/);
      return Response.json({ total_items: 1, campaigns: [draft] });
    }
    assert.equal(target.pathname, `/3.0/campaigns/${draft.id}`);
    return Response.json({ ...draft, private: 'not-returned' });
  };
  const list = await action('list-campaigns').execute(credential, {}, {});
  assert.equal(list.items?.[1].audienceId, draft.recipients.list_id);
  assert.equal(list.items?.[0].hasMore, false);
  const detail = await action('get-campaign').execute(credential, campaignValues, {});
  assert.equal(detail.items?.[0].status, 'save');
  assert.equal(detail.items?.[0].subject, 'Our news');
  assert.equal(JSON.stringify(detail).includes('not-returned'), false);
});

test('Mailchimp pagination rejects invalid inputs and inconsistent pages', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  const invalidPages: ActionValues[] = [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { offset: '-1' }, { offset: '1000001' }];
  for (const values of invalidPages) {
    await assert.rejects(action('list-audiences').execute(credential, values, {}), /whole-number/);
  }
  assert.equal(calls, 0);
  for (const body of [{ total_items: 3, lists: [] }, { total_items: 0, lists: [{}] }, { total_items: 2, lists: [{}, {}] }, { total_items: '1', lists: [{}] }]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(action('list-audiences').execute(credential, { limit: '1' }, {}), /invalid or inconsistent/);
  }
});

test('Mailchimp creates a regular draft with explicit audience and sender without calling any send endpoint', async () => {
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    requests++;
    assert.equal(url(input, init).pathname, '/3.0/campaigns');
    assert.equal(init?.method, 'POST');
    assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(String(init?.body)), { type: 'regular', recipients: { list_id: 'a123456789' }, settings: { title: 'October newsletter', subject_line: 'Our news', from_name: 'Example', reply_to: 'news@example.com' } });
    return Response.json(draft);
  };
  const result = await action('create-campaign').execute(credential, createValues, {});
  assert.equal(requests, 1);
  assert.equal(result.items?.[0].campaignId, draft.id);
  assert.match(result.summary, /No email was sent/);
});

test('Mailchimp validates identifiers, sender fields and HTML limits before network requests', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({}); };
  for (const changes of [{ audienceId: '../campaigns' }, { title: 't'.repeat(101) }, { subject: 's'.repeat(151) }, { fromName: 'f'.repeat(101) }, { subject: 'Subject\r\nBcc: injection' }, { replyTo: 'invalid@example' }, { replyTo: 'name <news@example.com>' }]) {
    await assert.rejects(action('create-campaign').execute(credential, { ...createValues, ...changes }, {}), ProviderError);
  }
  for (const campaignId of ['../send', 'id?send=yes', 'id/campaign', 'id#other', 'id%2fother', '']) {
    await assert.rejects(action('get-campaign').execute(credential, { campaignId }, {}), ProviderError);
  }
  for (const html of ['', 'x'.repeat(50_001), '<p>hello\u0000</p>']) {
    await assert.rejects(action('set-campaign-content').execute(credential, { campaignId: draft.id, html }, {}), ProviderError);
  }
  await assert.rejects(action('send-campaign').execute(credential, { campaignId: draft.id, audienceId: '../lists' }, {}), ProviderError);
  assert.equal(requests, 0);
});

test('Mailchimp only replaces content after verifying a regular draft and never sends as a side effect', async () => {
  const methods: string[] = [];
  const html = '<p>Hello</p><a href="*|UNSUB|*">Unsubscribe</a>*|HTML:LIST_ADDRESS_HTML|*';
  globalThis.fetch = async (input, init) => {
    const target = url(input, init);
    methods.push(init?.method || 'GET');
    if (!init?.method) {
      assert.equal(target.pathname, `/3.0/campaigns/${draft.id}`);
      return Response.json(draft);
    }
    assert.equal(target.pathname, `/3.0/campaigns/${draft.id}/content`);
    assert.equal(init.method, 'PUT');
    assert.deepEqual(JSON.parse(String(init.body)), { html });
    return Response.json({ html, private: 'not-returned' });
  };
  const result = await action('set-campaign-content').execute(credential, { campaignId: draft.id, html }, {});
  assert.deepEqual(methods, ['GET', 'PUT']);
  assert.deepEqual(result.items, [{ campaignId: draft.id }]);
  assert.match(result.summary, /No email was sent/);
});

test('Mailchimp sends only a regular draft bound to the requested audience and handles an empty 204 response', async () => {
  const methods: string[] = [];
  globalThis.fetch = async (input, init) => {
    const target = url(input, init);
    methods.push(init?.method || 'GET');
    if (!init?.method) return Response.json(draft);
    assert.equal(target.pathname, `/3.0/campaigns/${draft.id}/actions/send`);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, undefined);
    return new Response(null, { status: 204 });
  };
  const result = await action('send-campaign').execute(credential, campaignValues, {});
  assert.deepEqual(methods, ['GET', 'POST']);
  assert.deepEqual(result.items, [campaignValues]);
  assert.match(result.summary, /Delivery is not confirmed/);
  assert.equal(action('send-campaign').definition.schedulable, undefined);
});

test('Mailchimp refuses changes to sent or non-regular campaigns and refuses mismatched send audiences', async () => {
  let writes = 0;
  for (const campaign of [{ ...draft, status: 'sent' }, { ...draft, status: 'sending' }, { ...draft, status: 'schedule' }, { ...draft, type: 'rss' }]) {
    globalThis.fetch = async (_input, init) => { if (init?.method) writes++; return Response.json(campaign); };
    await assert.rejects(action('set-campaign-content').execute(credential, { campaignId: draft.id, html: '<p>Hello</p>' }, {}), /still a draft/);
    await assert.rejects(action('send-campaign').execute(credential, campaignValues, {}), /still a draft/);
  }
  globalThis.fetch = async (_input, init) => { if (init?.method) writes++; return Response.json(draft); };
  await assert.rejects(action('send-campaign').execute(credential, { ...campaignValues, audienceId: 'anotherAudience' }, {}), /does not match/);
  assert.equal(writes, 0);
});

test('Mailchimp report reads return selected aggregate metrics without subscriber data', async () => {
  globalThis.fetch = async (input, init) => {
    assert.equal(url(input, init).pathname, `/3.0/reports/${draft.id}`);
    assert.equal(init?.method, undefined);
    return Response.json({ id: draft.id, campaign_title: 'October newsletter', subject_line: 'Our news', emails_sent: 20, unsubscribed: 1, abuse_reports: 0, bounces: { hard_bounces: 0, soft_bounces: 1 }, opens: { unique_opens: 10, open_rate: 0.5 }, clicks: { unique_subscriber_clicks: 4, click_rate: 0.2 }, subscriber_activity: 'private-subscriber-data' });
  };
  const result = await action('get-campaign-report').execute(credential, campaignValues, {});
  assert.equal(result.items?.[0].emailsSent, 20);
  assert.equal(result.items?.[0].uniqueClickers, 4);
  assert.equal(result.items?.[0].openRate, 0.5);
  assert.equal(JSON.stringify(result).includes('private-subscriber-data'), false);
});

test('Mailchimp upstream failures redact credentials and explain ambiguity before retrying a write', async () => {
  globalThis.fetch = async () => Response.json({ detail: credential.accessToken }, { status: 400 });
  await assert.rejects(action('create-campaign').execute(credential, createValues, {}), (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.message.includes(credential.accessToken), false);
    assert.match(error.message, /before retrying/);
    return true;
  });
  globalThis.fetch = async () => { throw new Error(`network private-token ${credential.accessToken}`); };
  await assert.rejects(action('create-campaign').execute(credential, createValues, {}), /may have accepted/);
  globalThis.fetch = async () => Response.json({ success: true });
  await assert.rejects(action('create-campaign').execute(credential, createValues, {}), /Check your campaigns before retrying/);
});

test('Mailchimp send is protected by pipeline confirmation and idempotent receipts', async (t) => {
  const store = new Store(':memory:', Buffer.alloc(32, 63));
  t.after(() => store.close());
  store.save('mailchimp', credential, { accountId: 'account123', accountName: 'Example', resources: [] });
  const pipeline = new Pipeline(store, {}, {
    getAction: (_provider, id) => action(id),
    listActions: () => mailchimpActions.map((item) => item.definition),
    validateValues,
  });
  let reads = 0;
  let sends = 0;
  globalThis.fetch = async (_input, init) => {
    if (!init?.method) { reads++; return Response.json(draft); }
    sends++;
    return new Response(null, { status: 204 });
  };
  for (const confirmed of [undefined, false, 'true']) {
    await assert.rejects(pipeline.run('mailchimp', 'send-campaign', campaignValues, confirmed, 'mailchimp-send-123'), /Explicit confirmation/);
  }
  await assert.rejects(pipeline.run('mailchimp', 'send-campaign', campaignValues, true), /requestId/);
  assert.equal(reads, 0);
  assert.equal(sends, 0);
  const first = await pipeline.run('mailchimp', 'send-campaign', campaignValues, true, 'mailchimp-send-123');
  const repeated = await pipeline.run('mailchimp', 'send-campaign', campaignValues, true, 'mailchimp-send-123');
  assert.deepEqual(repeated, first);
  assert.equal(first.job?.status, 'succeeded');
  assert.equal(reads, 1);
  assert.equal(sends, 1);
  assert.ok(mailchimpActions.filter((item) => ['create-campaign', 'set-campaign-content', 'send-campaign'].includes(item.definition.id)).every((item) => item.definition.kind === 'write'));
});
