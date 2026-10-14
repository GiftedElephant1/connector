import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { googleActions } from '../server/actions-google';
import { validateValues } from '../server/actions';
import { ProviderError } from '../server/provider-types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'private-google-token' };
const ga = { propertyId: '123', eventName: 'generate_lead', countingMethod: 'ONCE_PER_EVENT' };
const event = { name: 'properties/123/keyEvents/456', eventName: 'generate_lead', countingMethod: 'ONCE_PER_EVENT' };
const sitemap = { siteUrl: 'sc-domain:example.com', sitemapUrl: 'https://example.com/sitemap.xml?language=en&part=2' };
const action = (provider: string, id: string) => {
  const result = googleActions.find((item) => item.provider === provider && item.definition.id === id);
  assert.ok(result);
  return result;
};

function reply(body: unknown = {}, status = 200) {
  const requests: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init });
    return status === 204 ? new Response(null, { status }) : Response.json(body, { status });
  };
  return requests;
}

test('GA4 creates a key event using the official Admin API with only explicit supported fields', async () => {
  const requests = reply({ ...event, privateField: credential.accessToken });
  const result = await action('google-analytics', 'create-key-event').execute(credential, { ...ga, propertyId: 'properties/123' }, {});
  assert.equal(requests.length, 1);
  const { url, init } = requests[0];
  assert.equal(url, 'https://analyticsadmin.googleapis.com/v1beta/properties/123/keyEvents');
  assert.equal(init?.method, 'POST');
  assert.equal(init?.redirect, 'error');
  assert.ok(init?.signal);
  assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential.accessToken}`);
  assert.deepEqual(JSON.parse(String(init?.body)), { eventName: ga.eventName, countingMethod: ga.countingMethod });
  assert.deepEqual(result.items, [{ keyEvent: event.name, eventName: ga.eventName, countingMethod: ga.countingMethod }]);
  assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
  assert.match(result.summary, /historical reports are unchanged/);
  assert.equal(action('google-analytics', 'create-key-event').definition.kind, 'write');
});

test('GA4 key event patch uses counting_method update mask and cannot change the event name', async () => {
  const requests = reply({ ...event, countingMethod: 'ONCE_PER_SESSION' });
  const result = await action('google-analytics', 'update-key-event').execute(credential, { propertyId: '123', keyEventId: event.name, countingMethod: 'ONCE_PER_SESSION' }, {});
  assert.equal(requests[0].url, `https://analyticsadmin.googleapis.com/v1beta/${event.name}?updateMask=counting_method`);
  assert.equal(requests[0].init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { countingMethod: 'ONCE_PER_SESSION' });
  assert.equal(result.items?.[0].countingMethod, 'ONCE_PER_SESSION');
  assert.equal(action('google-analytics', 'update-key-event').definition.kind, 'write');
});

test('GA4 validates key event names, counting methods and matching property resources before network access', async () => {
  const requests = reply(event);
  for (const values of [
    { ...ga, propertyId: '../123' }, { ...ga, propertyId: '123/456' },
    { ...ga, eventName: '123lead' }, { ...ga, eventName: 'generate lead' }, { ...ga, eventName: 'x'.repeat(41) },
    { ...ga, countingMethod: 'COUNTING_METHOD_UNSPECIFIED' },
  ]) await assert.rejects(action('google-analytics', 'create-key-event').execute(credential, values, {}), ProviderError);
  for (const keyEventId of ['../456', 'properties/999/keyEvents/456', 'properties/123/keyEvents/456?updateMask=*']) {
    await assert.rejects(action('google-analytics', 'update-key-event').execute(credential, { ...ga, keyEventId }, {}), /key event ID/);
  }
  assert.equal(requests.length, 0);
});

test('GA4 does not report success when response resource, requested settings or structure is wrong', async () => {
  for (const body of [
    {}, [], { ...event, name: 'properties/999/keyEvents/456' }, { ...event, name: 'properties/123/keyEvents/../456' },
    { ...event, eventName: 'different_event' }, { ...event, countingMethod: 'ONCE_PER_SESSION' },
    { error: { message: credential.accessToken } },
  ]) {
    reply(body);
    await assert.rejects(action('google-analytics', 'create-key-event').execute(credential, ga, {}), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.message.includes(credential.accessToken), false);
      return true;
    });
  }
  reply({ ...event, name: 'properties/123/keyEvents/999' });
  await assert.rejects(action('google-analytics', 'update-key-event').execute(credential, { ...ga, keyEventId: '456' }, {}), /did not confirm/);
});

test('GA4 key event list returns usable resource IDs, reports more pages and rejects malformed lists', async () => {
  const requests = reply({ keyEvents: [event], nextPageToken: 'unfollowed-page' });
  const result = await action('google-analytics', 'list-key-events').execute(credential, { propertyId: '123' }, {});
  assert.equal(requests[0].url, 'https://analyticsadmin.googleapis.com/v1beta/properties/123/keyEvents?pageSize=100');
  assert.equal(requests[0].init?.method, 'GET');
  assert.equal(result.items?.[0].keyEvent, event.name);
  assert.match(result.summary, /More key events/);
  reply({});
  assert.deepEqual((await action('google-analytics', 'list-key-events').execute(credential, { propertyId: '123' }, {})).items, []);
  for (const keyEvents of ['invalid', [null], [{}]]) {
    reply({ keyEvents });
    await assert.rejects(action('google-analytics', 'list-key-events').execute(credential, { propertyId: '123' }, {}), ProviderError);
  }
});

test('Search Console submits a sitemap with PUT, encoded property/feed identifiers and no arbitrary fetch', async () => {
  const requests = reply({}, 204);
  const result = await action('search-console', 'submit-sitemap').execute(credential, sitemap, {});
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(sitemap.siteUrl)}/sitemaps/${encodeURIComponent(sitemap.sitemapUrl)}`);
  assert.equal(requests[0].init?.method, 'PUT');
  assert.equal(requests[0].init?.body, undefined);
  assert.equal(new Headers(requests[0].init?.headers).get('authorization'), `Bearer ${credential.accessToken}`);
  assert.deepEqual(result.items, [sitemap]);
  assert.match(result.summary, /not guaranteed/);
  assert.equal(action('search-console', 'submit-sitemap').definition.kind, 'write');
});

test('Search Console removal uses DELETE and explains that crawling and published files are unaffected', async () => {
  const requests = reply({});
  const values = { ...sitemap, siteUrl: 'http://example.com/blog/' };
  const result = await action('search-console', 'delete-sitemap').execute(credential, values, {});
  assert.equal(requests[0].url, `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(values.siteUrl)}/sitemaps/${encodeURIComponent(values.sitemapUrl)}`);
  assert.equal(requests[0].init?.method, 'DELETE');
  assert.equal(requests[0].init?.body, undefined);
  assert.match(result.summary, /file, crawled URLs and search listings remain unchanged/);
  assert.equal(action('search-console', 'delete-sitemap').definition.kind, 'write');
});

test('Search Console accepts HTTP sitemap identifiers through shared action validation without fetching them', async () => {
  for (const actionId of ['submit-sitemap', 'delete-sitemap']) {
    const requests = reply({}, 204);
    const adapter = action('search-console', actionId);
    const values = validateValues(adapter, { siteUrl: 'http://example.com/', sitemapUrl: 'http://example.com/sitemap.xml' });
    await adapter.execute(credential, values, {});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://searchconsole.googleapis.com/webmasters/v3/sites/http%3A%2F%2Fexample.com%2F/sitemaps/http%3A%2F%2Fexample.com%2Fsitemap.xml');
    assert.equal(requests[0].init?.method, actionId === 'submit-sitemap' ? 'PUT' : 'DELETE');
  }
});

test('Search Console rejects malformed properties or sitemap URLs before network access', async () => {
  const requests = reply();
  for (const siteUrl of ['sc-domain:', 'sc-domain:example..com', 'sc-domain:example.com/path', 'https://user:secret@example.com/', 'file:///tmp/property', 'https://example.com/#fragment']) {
    await assert.rejects(action('search-console', 'submit-sitemap').execute(credential, { ...sitemap, siteUrl }, {}), ProviderError);
  }
  for (const sitemapUrl of ['data:text/xml,abc', 'https://user:secret@example.com/sitemap.xml', 'https://example.com/sitemap.xml#fragment', 'https://example.com/site map.xml']) {
    await assert.rejects(action('search-console', 'delete-sitemap').execute(credential, { ...sitemap, sitemapUrl }, {}), ProviderError);
  }
  assert.equal(requests.length, 0);
});

test('Google write permission failures and malformed successful responses never leak upstream credentials', async () => {
  for (const [provider, id, values] of [
    ['google-analytics', 'create-key-event', ga], ['search-console', 'submit-sitemap', sitemap],
  ] as const) {
    reply({ error: { message: credential.accessToken } }, 403);
    await assert.rejects(action(provider, id).execute(credential, values, {}), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /Reconnect with the required permissions/);
      assert.equal(error.message.includes(credential.accessToken), false);
      return true;
    });
  }
  for (const body of [[], { success: false }, { error: credential.accessToken }]) {
    reply(body);
    await assert.rejects(action('search-console', 'submit-sitemap').execute(credential, sitemap, {}), ProviderError);
  }
});
