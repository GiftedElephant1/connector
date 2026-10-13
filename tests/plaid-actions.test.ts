import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { plaidActions } from '../server/actions-plaid';
import type { Credential } from '../server/provider-types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const env = { PLAID_CLIENT_ID: 'client-one', PLAID_SECRET: 'secret-one', PLAID_ENV: 'sandbox' };
const credential: Credential = { accessToken: 'access-private', fields: { plaidEnvironment: 'sandbox', plaidClientId: env.PLAID_CLIENT_ID, plaidItemId: 'item-one' } };
const action = (id: string) => {
  const result = plaidActions.find(item => item.definition.id === id);
  assert.ok(result);
  return result;
};
const dates = { startDate: '2026-10-01', endDate: '2026-10-14' };

test('Plaid exposes only read actions and masks account identifiers without returning banking secrets', async () => {
  assert.ok(plaidActions.every(item => item.definition.kind === 'read' && !item.definition.schedulable));
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://sandbox.plaid.com/accounts/get');
    assert.equal(JSON.parse(String(init?.body)).access_token, credential.accessToken);
    return Response.json({ accounts: [{ account_id: 'account-one', name: 'Checking', type: 'depository', subtype: 'checking', mask: '123456789', routing_number: 'secret-routing', account_number: 'full-secret-account', balances: { current: 45 } }] });
  };
  const result = await action('list-accounts').execute(credential, {}, env);
  assert.match(result.summary, /SANDBOX test data/);
  assert.deepEqual(result.items, [{ accountId: 'account-one', name: 'Checking', type: 'depository', subtype: 'checking', maskedNumber: '•••• 6789' }]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('balance reads preserve null values and currency without placing amounts in the summary', async () => {
  globalThis.fetch = async url => {
    assert.equal(url, 'https://sandbox.plaid.com/accounts/balance/get');
    return Response.json({ accounts: [{ account_id: 'a', name: 'Checking', mask: '0001', balances: { current: 123.45, available: null, limit: null, iso_currency_code: 'USD', private: 'private' } }] });
  };
  const result = await action('read-balances').execute(credential, {}, env);
  assert.equal(result.items?.[0].current, 123.45);
  assert.equal(result.items?.[0].available, null);
  assert.equal(result.items?.[0].currency, 'USD');
  assert.equal(result.summary.includes('123.45'), false);
  assert.match(action('read-balances').definition.description, /charges/);
});

test('transaction reads return one bounded page with explicit continuation information and selected fields', async () => {
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.equal(url, 'https://sandbox.plaid.com/transactions/get');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.start_date, dates.startDate);
    assert.equal(body.end_date, dates.endDate);
    assert.deepEqual(body.options, { offset: 3, count: 2, include_original_description: false });
    return Response.json({ total_transactions: 8, transactions: [
      { transaction_id: 't4', account_id: 'a', date: '2026-10-12', name: 'Shop', merchant_name: 'Shop', amount: 5.5, iso_currency_code: 'USD', pending: false, original_description: 'private-original', location: { address: 'private-address' }, payment_meta: { reference_number: 'private-reference' } },
      { transaction_id: 't5', account_id: 'a', date: '2026-10-11', name: 'Refund', amount: -5.5, unofficial_currency_code: 'USD', pending: true },
    ] });
  };
  const result = await action('read-transactions').execute(credential, { ...dates, offset: '3', limit: '2' }, env);
  assert.equal(requests, 1);
  assert.match(result.summary, /2 of 8.*offset 3.*request offset 5/);
  assert.deepEqual(result.items?.[0], { rowType: 'pagination', returned: 2, total_transactions: 8, has_more: true, next_offset: 5 });
  assert.equal(result.items?.[2].amount, -5.5);
  assert.equal(result.items?.[2].pending, true);
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('empty and final transaction pages distinguish no results from more available', async () => {
  globalThis.fetch = async () => Response.json({ total_transactions: 0, transactions: [] });
  const empty = await action('read-transactions').execute(credential, dates, env);
  assert.deepEqual(empty.items?.[0], { rowType: 'pagination', returned: 0, total_transactions: 0, has_more: false, next_offset: null });
  globalThis.fetch = async () => Response.json({ total_transactions: 1, transactions: [{ transaction_id: 't1' }] });
  const last = await action('read-transactions').execute(credential, dates, env);
  assert.equal(last.items?.[0].has_more, false);
});

test('invalid dates, pagination and changed environment fail before fetching', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const values of [
    { ...dates, startDate: '2026-02-30' }, { ...dates, endDate: '2026-01-01' }, { ...dates, startDate: '2020-01-01' },
    { ...dates, limit: '101' }, { ...dates, limit: '0' }, { ...dates, offset: '-1' }, { ...dates, offset: '1.5' }, { ...dates, offset: '1000001' },
  ]) await assert.rejects(action('read-transactions').execute(credential, values, env));
  await assert.rejects(action('read-balances').execute(credential, {}, { ...env, PLAID_ENV: 'production' }), /different Plaid settings/);
  assert.equal(calls, 0);
});

test('inconsistent or oversized Plaid pages are never misrepresented as a complete result', async () => {
  for (const body of [
    { total_transactions: 3, transactions: [] },
    { total_transactions: 0, transactions: [{}] },
    { total_transactions: 3, transactions: [{}, {}, {}] },
    { total_transactions: '1', transactions: [{}] },
  ]) {
    globalThis.fetch = async () => Response.json(body);
    await assert.rejects(action('read-transactions').execute(credential, { ...dates, limit: '2' }, env), /invalid or oversized|inconsistent/);
  }
});
