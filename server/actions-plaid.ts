import type { ActionAdapter, ActionValues } from './action-types';
import { ProviderError } from './provider-types';
import { isObject } from './provider-http';
import { maskedAccount, plaidLabel, plaidRecords, plaidRequest, plaidText } from './plaid-http';

const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
function date(values: ActionValues, name: string): string {
  const value = values[name]?.trim();
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new ProviderError(`${name} must be a valid date in YYYY-MM-DD format.`);
  return value;
}
function integer(values: ActionValues, name: string, fallback: number, minimum: number, maximum: number): number {
  const value = values[name]?.trim() || String(fallback);
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < minimum || number > maximum) throw new ProviderError(`${name} must be a whole number from ${minimum} to ${maximum}.`);
  return number;
}

export const plaidActions: ActionAdapter[] = [
  {
    provider: 'plaid',
    definition: { id: 'list-accounts', label: 'List bank accounts', group: 'analytics', kind: 'read', description: 'Read the connected institution’s account names and masked identifiers. Sandbox returns test accounts. No bank credentials or full account numbers are returned.', fields: [] },
    execute: async (credential, _values, env) => {
      const accounts = plaidRecords(await plaidRequest('/accounts/get', {}, env, credential), 'accounts');
      return { summary: `${plaidLabel(env)}: ${accounts.length} authorized accounts.`, items: accounts.map(account => ({ accountId: plaidText(account.account_id), name: plaidText(account.name), type: plaidText(account.type), subtype: plaidText(account.subtype), maskedNumber: maskedAccount(account.mask) })) };
    },
  },
  {
    provider: 'plaid',
    definition: { id: 'read-balances', label: 'Read bank balances', group: 'analytics', kind: 'read', description: 'Request current balances from Plaid. This read may incur Plaid Balance API charges. Sandbox returns test data; balances can be unavailable for some accounts.', fields: [] },
    execute: async (credential, _values, env) => {
      const accounts = plaidRecords(await plaidRequest('/accounts/balance/get', {}, env, credential), 'accounts');
      return { summary: `${plaidLabel(env)}: balances for ${accounts.length} accounts; null means unavailable.`, items: accounts.map(account => {
        const balances = isObject(account.balances) ? account.balances : {};
        return { accountId: plaidText(account.account_id), name: plaidText(account.name), maskedNumber: maskedAccount(account.mask), current: finite(balances.current), available: finite(balances.available), limit: finite(balances.limit), currency: plaidText(balances.iso_currency_code) || plaidText(balances.unofficial_currency_code) || null };
      }) };
    },
  },
  {
    provider: 'plaid',
    definition: {
      id: 'read-transactions', label: 'Read bank transactions', group: 'analytics', kind: 'read',
      description: 'Read one bounded page of transactions for an explicit date range. A pagination row reports has_more and next_offset. Data is from Plaid’s latest bank update; Sandbox is test data. Positive amounts are money leaving the account; negative amounts are money entering.',
      fields: [
        { name: 'startDate', label: 'Start date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
        { name: 'endDate', label: 'End date', type: 'text', required: true, placeholder: 'YYYY-MM-DD' },
        { name: 'offset', label: 'Offset', type: 'number', default: '0', help: 'Use next_offset from the previous response to request another page.' },
        { name: 'limit', label: 'Page size', type: 'number', default: '100', help: 'Between 1 and 100 transactions per request.' },
      ],
    },
    execute: async (credential, values, env) => {
      const start = date(values, 'startDate');
      const end = date(values, 'endDate');
      if (end < start || Date.parse(end) - Date.parse(start) > 730 * 24 * 60 * 60_000) throw new ProviderError('Choose an ordered date range of no more than 730 days.');
      const offset = integer(values, 'offset', 0, 0, 1_000_000);
      const limit = integer(values, 'limit', 100, 1, 100);
      const body = await plaidRequest('/transactions/get', { start_date: start, end_date: end, options: { offset, count: limit, include_original_description: false } }, env, credential);
      const transactions = plaidRecords(body, 'transactions', limit);
      const total = body.total_transactions;
      if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || (transactions.length && offset + transactions.length > total) || (!transactions.length && offset < total)) throw new ProviderError('Plaid returned inconsistent transaction pagination. Try reading again.', 502);
      const hasMore = offset + transactions.length < total;
      const nextOffset = hasMore ? offset + transactions.length : null;
      return {
        summary: `${plaidLabel(env)}: ${transactions.length} of ${total} transactions, starting at offset ${offset}. ${hasMore ? `More transactions are available; request offset ${nextOffset}.` : 'No further page in this date range.'} History reflects Plaid’s latest bank update.`,
        items: [
          { rowType: 'pagination', returned: transactions.length, total_transactions: total, has_more: hasMore, next_offset: nextOffset },
          ...transactions.map(transaction => ({ rowType: 'transaction', transactionId: plaidText(transaction.transaction_id), accountId: plaidText(transaction.account_id), date: plaidText(transaction.date), name: plaidText(transaction.name), merchant: plaidText(transaction.merchant_name), amount: finite(transaction.amount), currency: plaidText(transaction.iso_currency_code) || plaidText(transaction.unofficial_currency_code) || null, pending: transaction.pending === true })),
        ],
      };
    },
  },
];
