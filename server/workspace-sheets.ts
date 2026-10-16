import { bearer, required, string } from './action-http';
import type { ActionAdapter, ActionField, ActionResult, ActionValues } from './action-types';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';

const origin = 'https://sheets.googleapis.com/v4';
const MAX_JSON = 500_000;
const MAX_RESULT = 200_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const field = (name: string, label: string, required = true, type: ActionField['type'] = 'text'): ActionField => ({ name, label, required, type });
const spreadsheetField = field('spreadsheetId', 'Spreadsheet ID');
const rangeField: ActionField = { ...field('range', 'A1 cell range'), placeholder: "'Sheet 1'!A1:C10" };
const rowsField: ActionField = { ...field('values', 'Rows as JSON', true, 'textarea'), maxLength: MAX_JSON, help: '1–100 rows, 1–100 cells per row; strings, numbers or booleans. Maximum 500,000 characters.' };
const sheetField = field('sheetId', 'Numeric tab ID (from Read spreadsheet)', true, 'number');
const titleField = field('title', 'Title');
const inputOption: ActionField = { name: 'valueInputOption', label: 'How to interpret values', type: 'select', default: 'RAW', options: [
  { value: 'RAW', label: 'Literal values (RAW)' }, { value: 'USER_ENTERED', label: 'Calculate formulas and parse dates/numbers (USER_ENTERED)' },
], help: 'USER_ENTERED behaves like typing in Sheets, including formula evaluation and locale-dependent number/date parsing. RAW preserves text literally.' };

function bounded(values: ActionValues, key: string, max = MAX_JSON, optional = false): string {
  const value = optional ? values[key]?.trim() ?? '' : required(values, key);
  if (value.length > max || value.includes('\0')) throw new ProviderError(`${key} must contain at most ${max} characters without null bytes.`);
  return value;
}
function spreadsheetId(values: ActionValues): string {
  const value = required(values, 'spreadsheetId');
  if (!/^[A-Za-z0-9_-]{1,250}$/.test(value)) throw new ProviderError('spreadsheetId must be a spreadsheet ID without a URL or path.');
  return value;
}
function integer(values: ActionValues, key: string, optional = false): number | undefined {
  const value = bounded(values, key, 12, optional);
  if (!value && optional) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) throw new ProviderError(`${key} must be a non-negative integer no greater than 2147483647.`);
  return Number(value);
}
function parseJson(values: ActionValues, key: string): unknown {
  const value = bounded(values, key);
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new ProviderError(`${key} must contain valid JSON.`); }
  const queue = [{ value: parsed, depth: 0 }];
  let visited = 0;
  while (queue.length) {
    const item = queue.pop()!;
    if (++visited > 100_000 || item.depth > 60) throw new ProviderError(`${key} contains too many values or excessive JSON nesting. Split the request.`);
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new ProviderError(`${key} must contain only finite numbers.`);
    if (Array.isArray(item.value) || isObject(item.value)) for (const child of Object.values(item.value)) queue.push({ value: child, depth: item.depth + 1 });
  }
  return parsed;
}
function rows(values: ActionValues) {
  const result = parseJson(values, 'values');
  if (!Array.isArray(result) || result.length < 1 || result.length > 100 || result.some(row => !Array.isArray(row) || row.length < 1 || row.length > 100 || row.some(cell => !['string', 'number', 'boolean'].includes(typeof cell) || typeof cell === 'number' && !Number.isFinite(cell) || typeof cell === 'string' && cell.length > 50_000))) {
    throw new ProviderError('Supply 1–100 rows of 1–100 string, number, or boolean cells, with at most 50,000 characters in each cell.');
  }
  return result;
}
function choice(values: ActionValues, key: string, options: readonly string[], fallback: string) {
  const value = values[key]?.trim() || fallback;
  if (!options.includes(value)) throw new ProviderError(`Choose a valid ${key}.`);
  return value;
}
async function request(credential: Credential, path: string, method = 'GET', body?: unknown) {
  const isWrite = method !== 'GET';
  const uncertain = isWrite ? ' Google may have applied this write. Check the spreadsheet before retrying.' : '';
  const headers = { ...bearer(credential), accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, {
      method, headers, ...(serialized === undefined ? {} : { body: serialized }), redirect: 'error', signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new ProviderError(`Google Sheets did not return a response.${uncertain}`, 502);
  }
  const cancel = async () => { try { await response.body?.cancel(); } catch { /* Preserve the original failure. */ } };
  if (!response.ok || response.redirected) {
    await cancel();
    if (response.status === 401 || response.status === 403) throw new ProviderError('Google Sheets denied this action. Reconnect with the required permissions and check the spreadsheet sharing settings.', response.status);
    if (response.status === 429) throw new ProviderError('Google Sheets is rate limiting requests. Try again later.', 429);
    if (response.status >= 400 && response.status < 500 && response.status !== 408) throw new ProviderError(`Google Sheets rejected this request (HTTP ${response.status}). Check the requested fields, resource IDs and access permissions.`, response.status);
    throw new ProviderError(`Google Sheets could not complete this action (HTTP ${response.status}).${uncertain}`, 502);
  }
  const oversized = () => new ProviderError(`The Google Sheets response exceeded 1 MiB. Narrow fields/ranges or split the request.${uncertain}`, isWrite ? 502 : 413);
  const contentLength = response.headers.get('content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
    await cancel();
    throw oversized();
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError(`Google Sheets returned an empty response.${uncertain}`, 502);
  const chunks: Uint8Array[] = [];
  let length = 0;
  let completed = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw oversized();
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`Google Sheets did not finish returning its response.${uncertain}`, 502);
  } finally {
    if (!completed) { try { await reader.cancel(); } catch { /* Preserve the bounded read failure. */ } }
    reader.releaseLock();
  }
  let result: unknown;
  try { result = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
  catch { throw new ProviderError(`Google Sheets returned unreadable JSON.${uncertain}`, 502); }
  if (!isObject(result)) throw new ProviderError(`Google Sheets returned an unexpected response.${uncertain}`, 502);
  if (result.error !== undefined) throw new ProviderError('Google reported a failed operation. Check the spreadsheet before retrying a write.', 502);
  return result;
}
function confirmed(body: Record<string, unknown>, key: string): string {
  const value = string(body[key]);
  if (!value) throw new ProviderError('Google did not confirm this operation. Check the spreadsheet before retrying a write.', 502);
  return value;
}
function resultJson(value: unknown, isWrite = false): string {
  const result = JSON.stringify(value);
  if (result.length > MAX_RESULT) throw new ProviderError(`The Sheets response exceeds 200,000 characters. Narrow fields/ranges or split the request.${isWrite ? ' Google may have applied this write. Check the spreadsheet before retrying.' : ''}`, isWrite ? 502 : 413);
  return result;
}
function formatPaths(value: Record<string, unknown>, prefix = '', depth = 0): string[] {
  if (depth > 12) throw new ProviderError('CellFormat JSON nesting is too deep.');
  return Object.entries(value).flatMap(([key, child]) => {
    if (!/^[a-z][A-Za-z0-9]*$/.test(key)) throw new ProviderError('CellFormat must use official Google format property names.');
    const path = prefix ? `${prefix}.${key}` : key;
    return isObject(child) && Object.keys(child).length ? formatPaths(child, path, depth + 1) : [path];
  });
}
function adapter(id: string, label: string, kind: 'read' | 'write', description: string, fields: ActionField[], execute: ActionAdapter['execute']): ActionAdapter {
  return { provider: 'sheets', definition: { id, label, kind, group: 'publishing', description, fields }, execute };
}
async function batch(credential: Credential, id: string, requests: Record<string, unknown>[]): Promise<Record<string, unknown>> {
  const body = await request(credential, `/spreadsheets/${id}:batchUpdate`, 'POST', { requests });
  if (confirmed(body, 'spreadsheetId') !== id) throw new ProviderError('Google returned a different spreadsheet identifier. Check the spreadsheet before retrying.', 502);
  return body;
}
async function write(credential: Credential, values: ActionValues, formulas: boolean): Promise<ActionResult> {
  const id = spreadsheetId(values); const range = bounded(values, 'range', 300);
  const mode = formulas ? 'USER_ENTERED' : choice(values, 'valueInputOption', ['RAW', 'USER_ENTERED'], 'RAW');
  const body = await request(credential, `/spreadsheets/${id}/values/${encodeURIComponent(range)}?${new URLSearchParams({ valueInputOption: mode })}`, 'PUT', { range, majorDimension: 'ROWS', values: rows(values) });
  return { summary: mode === 'USER_ENTERED' ? 'Updated spreadsheet cells using USER_ENTERED. Formulas were submitted for calculation; read cells with FORMATTED_VALUE or UNFORMATTED_VALUE to verify results.' : 'Updated spreadsheet cells as literal values. Use write-formulas or USER_ENTERED to calculate formulas.', items: [{ range: confirmed(body, 'updatedRange'), updatedCells: string(body.updatedCells) }] };
}

export const workspaceSheetsActions: ActionAdapter[] = [
  adapter('read-values', 'Read cells', 'read', 'Read up to 100 rows and 100 cells per row. Select displayed values, calculated underlying numbers, or formula text. Narrow the A1 range to read additional rows.', [spreadsheetField, rangeField, {
    name: 'valueRenderOption', label: 'Cell representation', type: 'select', default: 'FORMATTED_VALUE', options: [
      { value: 'FORMATTED_VALUE', label: 'Displayed values' }, { value: 'UNFORMATTED_VALUE', label: 'Calculated raw values' }, { value: 'FORMULA', label: 'Formula text' },
    ],
  }, { name: 'dateTimeRenderOption', label: 'Dates with raw values/formulas', type: 'select', default: 'SERIAL_NUMBER', options: [{ value: 'SERIAL_NUMBER', label: 'Serial numbers' }, { value: 'FORMATTED_STRING', label: 'Formatted strings' }] }], async (credential, values) => {
    const mode = choice(values, 'valueRenderOption', ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'], 'FORMATTED_VALUE');
    const body = await request(credential, `/spreadsheets/${spreadsheetId(values)}/values/${encodeURIComponent(bounded(values, 'range', 300))}?${new URLSearchParams({ valueRenderOption: mode, dateTimeRenderOption: choice(values, 'dateTimeRenderOption', ['SERIAL_NUMBER', 'FORMATTED_STRING'], 'SERIAL_NUMBER') })}`);
    const allRows = Array.isArray(body.values) ? body.values.filter(Array.isArray) : [];
    const selectedRows = allRows.slice(0, 100);
    const clipped = allRows.length > 100 || selectedRows.some(row => row.length > 100);
    const items = selectedRows.map((row, index) => ({ rowOffset: index, values: resultJson(row.slice(0, 100).map((cell: unknown) => mode === 'FORMATTED_VALUE' ? typeof cell === 'boolean' || typeof cell === 'number' ? String(cell) : cell : cell)) }));
    resultJson(items);
    return { summary: `Read ${selectedRows.length} rows from ${string(body.range)} (at most 100 rows and 100 cells per row).${clipped ? ' Results were clipped; narrow the range to retrieve the remainder.' : ''}`, items };
  }),
  adapter('write-values', 'Write cells', 'write', 'Overwrite an A1 range with JSON rows. Defaults to RAW for literal text. Select USER_ENTERED to calculate formulas and parse numbers/dates using spreadsheet locale.', [spreadsheetField, rangeField, rowsField, inputOption], (credential, values) => write(credential, values, false)),
  adapter('write-formulas', 'Write formulas and calculated cells', 'write', 'Overwrite an A1 range with JSON rows using USER_ENTERED, exactly like typing into Sheets. Strings starting with = are formulas; other numbers, dates and text are parsed using spreadsheet locale. Read cells afterward to verify results.', [spreadsheetField, rangeField, rowsField], (credential, values) => write(credential, values, true)),
  adapter('append-values', 'Append rows', 'write', 'Append 1–100 rows after the table in an A1 range. Defaults to literal RAW; choose USER_ENTERED for formulas. Google determines the insertion row from the existing table.', [spreadsheetField, rangeField, rowsField, inputOption], async (credential, values) => {
    const id = spreadsheetId(values); const range = bounded(values, 'range', 300);
    const body = await request(credential, `/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?${new URLSearchParams({ valueInputOption: choice(values, 'valueInputOption', ['RAW', 'USER_ENTERED'], 'RAW'), insertDataOption: 'INSERT_ROWS' })}`, 'POST', { range, majorDimension: 'ROWS', values: rows(values) });
    const updates = isObject(body.updates) ? body.updates : {};
    return { summary: 'Appended spreadsheet rows.', items: [{ range: confirmed(updates, 'updatedRange'), updatedCells: string(updates.updatedCells), tableRange: string(body.tableRange) }] };
  }),
  adapter('clear-values', 'Clear cells', 'write', 'Clear values and formulas in an A1 range while preserving formatting and validation.', [spreadsheetField, rangeField], async (credential, values) => {
    const body = await request(credential, `/spreadsheets/${spreadsheetId(values)}/values/${encodeURIComponent(bounded(values, 'range', 300))}:clear`, 'POST', {});
    return { summary: 'Cleared spreadsheet values.', items: [{ range: confirmed(body, 'clearedRange') }] };
  }),
  adapter('create-spreadsheet', 'Create spreadsheet', 'write', 'Create an empty spreadsheet in the selected account. Use add-tab or batch-update to construct tabs, formulas, formats, charts and other supported Sheets features.', [titleField], async (credential, values) => {
    const body = await request(credential, '/spreadsheets', 'POST', { properties: { title: bounded(values, 'title', 200) } });
    const id = confirmed(body, 'spreadsheetId');
    return { summary: 'Created spreadsheet.', items: [{ spreadsheetId: id }], link: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(id)}/edit` };
  }),
  adapter('read-spreadsheet', 'Read spreadsheet structure and formatting', 'read', 'Read spreadsheet metadata, numeric tab IDs, properties and named ranges. Set an official Sheets fields mask to inspect formats, charts, pivots or cell data; use ranges JSON to limit grid data. Maximum response 200,000 characters. Google omits grid data unless requested with includeGridData or a fields mask.', [spreadsheetField,
    { ...field('fields', 'Google Sheets fields mask (optional)', false), help: 'Defaults to spreadsheetId,spreadsheetUrl,properties,sheets(properties),namedRanges. For cells use sheets(properties,data(rowData(values(userEnteredValue,effectiveValue,userEnteredFormat,effectiveFormat)))).' },
    { ...field('ranges', 'A1 ranges as a JSON array (optional)', false, 'textarea'), placeholder: '["Sheet1!A1:C20"]' },
    { name: 'includeGridData', label: 'Include cell data when using default fields', type: 'select', default: 'false', options: [{ value: 'false', label: 'No' }, { value: 'true', label: 'Yes (supply a narrow range)' }] },
  ], async (credential, values) => {
    const include = choice(values, 'includeGridData', ['true', 'false'], 'false');
    const fields = bounded(values, 'fields', 4000, true);
    const compactFields = fields.replaceAll(/\s/g, '');
    const requestsGrid = include === 'true' || compactFields.includes('*') || /(?:^|[,(\/])(?:data|rowData)(?:[(),\/]|$)/.test(compactFields) || /(?:^|,)sheets(?:,|$)/.test(compactFields);
    const params = new URLSearchParams({ ...(fields ? { fields } : include === 'false' ? { fields: 'spreadsheetId,spreadsheetUrl,properties,sheets(properties),namedRanges' } : {}), includeGridData: include });
    if (values.ranges?.trim()) {
      const ranges = parseJson(values, 'ranges');
      if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 100 || ranges.some(range => typeof range !== 'string' || !range.trim() || range.length > 300 || range.includes('\0'))) throw new ProviderError('ranges must be a JSON array of 1–100 A1 range strings.');
      for (const range of ranges) params.append('ranges', range);
    } else if (requestsGrid) throw new ProviderError('Supply ranges when requesting grid data or broad fields masks to keep the response bounded.');
    const body = await request(credential, `/spreadsheets/${spreadsheetId(values)}?${params}`);
    return { summary: 'Read spreadsheet structure. Use numeric sheetId values for tab and formatting actions.', items: [{ spreadsheetId: spreadsheetId(values), spreadsheet: resultJson(body) }] };
  }),
  adapter('add-tab', 'Add spreadsheet tab', 'write', 'Add a new grid tab. Google returns its numeric sheetId; use that ID for rename, formatting and other batch requests.', [spreadsheetField, titleField, field('rowCount', 'Row count (optional)', false, 'number'), field('columnCount', 'Column count (optional)', false, 'number')], async (credential, values) => {
    const id = spreadsheetId(values);
    const rowCount = integer(values, 'rowCount', true); const columnCount = integer(values, 'columnCount', true);
    if (rowCount === 0 || columnCount === 0) throw new ProviderError('Row and column counts must be positive integers.');
    const properties = { title: bounded(values, 'title', 100), ...(rowCount !== undefined || columnCount !== undefined ? { gridProperties: { ...(rowCount !== undefined ? { rowCount } : {}), ...(columnCount !== undefined ? { columnCount } : {}) } } : {}) };
    const body = await batch(credential, id, [{ addSheet: { properties } }]);
    const reply = Array.isArray(body.replies) && isObject(body.replies[0]) && isObject(body.replies[0].addSheet) && isObject(body.replies[0].addSheet.properties) ? body.replies[0].addSheet.properties : {};
    if (!Number.isInteger(reply.sheetId) || Number(reply.sheetId) < 0) throw new ProviderError('Google did not return the new tab ID. Check the spreadsheet before retrying.', 502);
    return { summary: 'Added spreadsheet tab.', items: [{ spreadsheetId: id, sheetId: Number(reply.sheetId), title: string(reply.title) }] };
  }),
  adapter('rename-tab', 'Rename spreadsheet tab', 'write', 'Rename an existing tab by numeric sheetId without changing its contents.', [spreadsheetField, sheetField, titleField], async (credential, values) => {
    const id = spreadsheetId(values); const sheetId = integer(values, 'sheetId')!; const title = bounded(values, 'title', 100);
    await batch(credential, id, [{ updateSheetProperties: { properties: { sheetId, title }, fields: 'title' } }]);
    return { summary: 'Renamed spreadsheet tab.', items: [{ spreadsheetId: id, sheetId, title }] };
  }),
  adapter('duplicate-tab', 'Duplicate spreadsheet tab', 'write', 'Duplicate a tab within the same spreadsheet. Copies the tab contents and formats; specify a unique new title.', [spreadsheetField, sheetField, titleField], async (credential, values) => {
    const id = spreadsheetId(values);
    const body = await batch(credential, id, [{ duplicateSheet: { sourceSheetId: integer(values, 'sheetId'), newSheetName: bounded(values, 'title', 100) } }]);
    const reply = Array.isArray(body.replies) && isObject(body.replies[0]) && isObject(body.replies[0].duplicateSheet) && isObject(body.replies[0].duplicateSheet.properties) ? body.replies[0].duplicateSheet.properties : {};
    if (!Number.isInteger(reply.sheetId) || Number(reply.sheetId) < 0) throw new ProviderError('Google did not return the duplicate tab ID. Check the spreadsheet before retrying.', 502);
    return { summary: 'Duplicated spreadsheet tab.', items: [{ spreadsheetId: id, sheetId: Number(reply.sheetId), title: string(reply.title) }] };
  }),
  adapter('delete-tab', 'Delete spreadsheet tab', 'write', 'Delete the selected tab and all of its contents. This is destructive and requires explicit write confirmation.', [spreadsheetField, sheetField], async (credential, values) => {
    const id = spreadsheetId(values); const sheetId = integer(values, 'sheetId')!;
    await batch(credential, id, [{ deleteSheet: { sheetId } }]);
    return { summary: 'Deleted spreadsheet tab.', items: [{ spreadsheetId: id, sheetId }] };
  }),
  adapter('format-cells', 'Format spreadsheet cells', 'write', 'Apply an official Sheets CellFormat object to a numeric GridRange. Supports fonts, colors, number/date/currency formats, alignment, wrapping and borders. Indexes are zero-based, end-exclusive. Only specified format properties change.', [spreadsheetField,
    { ...field('gridRange', 'GridRange as JSON', true, 'textarea'), placeholder: '{"sheetId":0,"startRowIndex":0,"endRowIndex":1,"startColumnIndex":0,"endColumnIndex":4}' },
    { ...field('format', 'CellFormat as JSON', true, 'textarea'), placeholder: '{"textFormat":{"bold":true},"numberFormat":{"type":"NUMBER","pattern":"0.00"}}' },
    { ...field('fields', 'CellFormat fields to change (optional)', false), help: 'Defaults to supplied format properties. For fine-grained updates use textFormat.bold,numberFormat. Do not prefix with userEnteredFormat. Use * to replace the entire format.' },
  ], async (credential, values) => {
    const id = spreadsheetId(values); const range = parseJson(values, 'gridRange'); const format = parseJson(values, 'format');
    if (!isObject(range) || !Number.isInteger(range.sheetId) || Number(range.sheetId) < 0 || Object.keys(range).some(key => !['sheetId', 'startRowIndex', 'endRowIndex', 'startColumnIndex', 'endColumnIndex'].includes(key)) || Object.values(range).some(value => typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647)) throw new ProviderError('gridRange must contain a numeric sheetId and optional non-negative integer row/column indexes.');
    for (const axis of ['Row', 'Column']) if (range[`end${axis}Index`] !== undefined && Number(range[`end${axis}Index`]) <= Number(range[`start${axis}Index`] ?? 0)) throw new ProviderError('Grid range end indexes must be greater than their start indexes.');
    if (!isObject(format) || Object.keys(format).length === 0) throw new ProviderError('format must be a non-empty official CellFormat JSON object.');
    const mask = bounded(values, 'fields', 2000, true) || formatPaths(format).join(',');
    if (mask !== '*' && !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*(?:,[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*)*$/.test(mask)) throw new ProviderError('fields must be comma-separated CellFormat property paths, or *.');
    if (mask.split(',').some(key => key === 'userEnteredFormat' || key.startsWith('userEnteredFormat.'))) throw new ProviderError('fields must be relative to CellFormat; omit userEnteredFormat.');
    await batch(credential, id, [{ repeatCell: { range, cell: { userEnteredFormat: format }, fields: mask === '*' ? 'userEnteredFormat' : mask.split(',').map(key => `userEnteredFormat.${key}`).join(',') } }]);
    return { summary: 'Applied spreadsheet cell formatting.', items: [{ spreadsheetId: id, gridRange: resultJson(range), fields: mask }] };
  }),
  adapter('batch-update', 'Apply advanced Sheets requests', 'write', 'Run 1–100 official spreadsheets.batchUpdate requests atomically (500,000 JSON characters). Supports tabs, formulas via updateCells, formatting, charts, pivot tables, conditional formats, data validation, filters, sorting, named/protected ranges, row/column sizes, merging and other official request types. Destructive requests are permitted only with the standard explicit write confirmation. Use Google Sheets API Request JSON, not URLs or HTTP instructions.', [spreadsheetField,
    { ...field('requests', 'Official Sheets Request array as JSON', true, 'textarea'), maxLength: MAX_JSON, help: 'https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/request — each array element contains one operation, for example {"addSheet":{"properties":{"title":"Summary"}}}.' },
  ], async (credential, values) => {
    const id = spreadsheetId(values); const requests = parseJson(values, 'requests');
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 100 || requests.some(entry => !isObject(entry) || Object.keys(entry).length !== 1 || !/^[a-z][A-Za-z0-9]{1,100}$/.test(Object.keys(entry)[0]) || !isObject(Object.values(entry)[0]))) throw new ProviderError('requests must be an array of 1–100 official Sheets request objects, each containing one operation object.');
    const body = await batch(credential, id, requests);
    return { summary: `Google accepted ${requests.length} spreadsheet requests atomically. Read the spreadsheet to verify formulas and formatting.`, items: [{ spreadsheetId: id, replies: resultJson(Array.isArray(body.replies) ? body.replies : [], true) }] };
  }),
];
