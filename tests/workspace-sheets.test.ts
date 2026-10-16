import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { validateValues } from '../server/actions';
import { ProviderError } from '../server/provider-types';
import { workspaceSheetsActions } from '../server/workspace-sheets';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'private-sheets-access-token' };
function action(id: string) {
  const result = workspaceSheetsActions.find(entry => entry.definition.id === id);
  assert.ok(result, `Missing action ${id}`);
  return result;
}
function mock(body: unknown, inspect: (url: URL, init: RequestInit, body: Record<string, any>) => void = () => {}) {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${credential.accessToken}`);
    assert.equal(url.toString().includes(credential.accessToken), false);
    inspect(url, init, init.body ? JSON.parse(String(init.body)) : {});
    return Response.json(body);
  };
}
async function run(id: string, values: Record<string, string>) {
  const selected = action(id);
  return selected.execute(credential, validateValues(selected, values), {});
}

test('Sheets catalog keeps all mutations behind standard write confirmation and exposes distinct formula action', () => {
  assert.equal(new Set(workspaceSheetsActions.map(entry => entry.definition.id)).size, workspaceSheetsActions.length);
  for (const entry of workspaceSheetsActions) {
    assert.equal(entry.provider, 'sheets');
    assert.equal(entry.definition.kind, ['read-values', 'read-spreadsheet'].includes(entry.definition.id) ? 'read' : 'write');
    assert.notEqual(entry.definition.schedulable, true);
  }
  assert.match(action('write-formulas').definition.description, /USER_ENTERED/);
  assert.equal(action('write-values').definition.fields.find(field => field.name === 'valueInputOption')?.default, 'RAW');
});

test('formula action sends USER_ENTERED and exact formula characters; it does not claim successful calculation', async () => {
  const formula = '=IF(A1>0,SUM(A1:A10),"No data")';
  mock({ updatedRange: "'Cash Flow'!B2", updatedCells: 1 }, (url, init, body) => {
    assert.equal(init.method, 'PUT');
    assert.equal(decodeURIComponent(url.pathname), "/v4/spreadsheets/book1/values/'Cash Flow'!B2");
    assert.equal(url.searchParams.get('valueInputOption'), 'USER_ENTERED');
    assert.deepEqual(body, { range: "'Cash Flow'!B2", majorDimension: 'ROWS', values: [[formula]] });
  });
  const result = await run('write-formulas', { spreadsheetId: 'book1', range: "'Cash Flow'!B2", values: JSON.stringify([[formula]]) });
  assert.match(result.summary, /submitted for calculation/);
  assert.match(result.summary, /verify results/);
});

test('write-values preserves RAW compatibility and accepts explicit USER_ENTERED', async () => {
  for (const mode of [undefined, 'RAW', 'USER_ENTERED']) {
    mock({ updatedRange: 'Sheet1!A1', updatedCells: 1 }, (url, _init, body) => {
      assert.equal(url.searchParams.get('valueInputOption'), mode ?? 'RAW');
      assert.deepEqual(body.values, [['=SUM(A2:A3)']]);
    });
    const result = await run('write-values', { spreadsheetId: 'book1', range: 'Sheet1!A1', values: '[["=SUM(A2:A3)"]]', ...(mode ? { valueInputOption: mode } : {}) });
    assert.equal(result.items?.[0].updatedCells, '1');
  }
});

test('read-values can return formula text or calculated numbers without stringifying unformatted types', async () => {
  for (const [mode, values] of [['FORMULA', [['=SUM(A2:A3)', 3]]], ['UNFORMATTED_VALUE', [[4.5, true]]], ['FORMATTED_VALUE', [[4.5, true]]]] as const) {
    mock({ range: 'Sheet1!A1:B1', values }, (url, init) => {
      assert.equal(init.method, 'GET');
      assert.equal(url.searchParams.get('valueRenderOption'), mode);
      assert.equal(url.searchParams.get('dateTimeRenderOption'), 'SERIAL_NUMBER');
    });
    const result = await run('read-values', { spreadsheetId: 'book1', range: 'Sheet1!A1:B1', valueRenderOption: mode });
    assert.deepEqual(JSON.parse(String(result.items?.[0].values)), mode === 'FORMATTED_VALUE' ? ['4.5', 'true'] : values[0]);
  }
});

test('read-values reports truncation explicitly and preserves long text within its output bound', async () => {
  mock({ range: 'A1:DW101', values: Array.from({ length: 101 }, (_, index) => index ? Array(101).fill(index) : ['x'.repeat(3000)]) });
  const result = await run('read-values', { spreadsheetId: 'book1', range: 'A1:DW101' });
  assert.equal(result.items?.length, 100);
  assert.match(result.summary, /clipped/);
  assert.equal(JSON.parse(String(result.items?.[0].values))[0].length, 3000);
  assert.equal(JSON.parse(String(result.items?.[1].values)).length, 100);
});

test('append-values uses official append semantics and requires update confirmation', async () => {
  mock({ tableRange: 'Log!A1:B2', updates: { updatedRange: 'Log!A3:B3', updatedCells: 2 } }, (url, init, body) => {
    assert.equal(decodeURIComponent(url.pathname), '/v4/spreadsheets/book1/values/Log!A:B:append');
    assert.equal(init.method, 'POST');
    assert.equal(url.searchParams.get('insertDataOption'), 'INSERT_ROWS');
    assert.equal(url.searchParams.get('valueInputOption'), 'USER_ENTERED');
    assert.deepEqual(body.values, [['2026-10-17', '=1+1']]);
  });
  assert.equal((await run('append-values', { spreadsheetId: 'book1', range: 'Log!A:B', values: '[["2026-10-17","=1+1"]]', valueInputOption: 'USER_ENTERED' })).items?.[0].range, 'Log!A3:B3');
  mock({});
  await assert.rejects(run('append-values', { spreadsheetId: 'book1', range: 'A1', values: '[[1]]' }), /did not confirm/);
});

test('clear-values keeps its request separate from formatting and spreadsheet deletion', async () => {
  mock({ spreadsheetId: 'book1', clearedRange: 'Summary!A2:C10' }, (url, init, body) => {
    assert.equal(decodeURIComponent(url.pathname), '/v4/spreadsheets/book1/values/Summary!A2:C10:clear');
    assert.equal(init.method, 'POST'); assert.deepEqual(body, {});
  });
  assert.equal((await run('clear-values', { spreadsheetId: 'book1', range: 'Summary!A2:C10' })).items?.[0].range, 'Summary!A2:C10');
});

test('read-spreadsheet lists zero-valued numeric tab IDs and supports narrowly selected grid fields', async () => {
  mock({ spreadsheetId: 'book1', properties: { title: 'Workbook' }, sheets: [{ properties: { sheetId: 0, title: 'Summary' } }] }, (url) => {
    assert.equal(url.pathname, '/v4/spreadsheets/book1');
    assert.equal(url.searchParams.get('includeGridData'), 'false');
    assert.equal(url.searchParams.get('fields'), 'spreadsheetId,spreadsheetUrl,properties,sheets(properties),namedRanges');
  });
  const result = await run('read-spreadsheet', { spreadsheetId: 'book1' });
  assert.equal(JSON.parse(String(result.items?.[0].spreadsheet)).sheets[0].properties.sheetId, 0);
  mock({ sheets: [{ data: [{ rowData: [{ values: [{ effectiveValue: { numberValue: 2 }, userEnteredValue: { formulaValue: '=1+1' } }] }] }] }] }, (url) => {
    assert.deepEqual(url.searchParams.getAll('ranges'), ['Summary!A1', 'Details!A2']);
    assert.equal(url.searchParams.get('fields'), 'sheets(data(rowData(values)))');
  });
  await run('read-spreadsheet', { spreadsheetId: 'book1', fields: 'sheets(data(rowData(values)))', ranges: '["Summary!A1","Details!A2"]', includeGridData: 'true' });
});

test('add-tab returns the actual provider-assigned ID and optional dimensions', async () => {
  mock({ spreadsheetId: 'book1', replies: [{ addSheet: { properties: { sheetId: 0, title: 'Forecast' } } }] }, (url, init, body) => {
    assert.equal(url.pathname, '/v4/spreadsheets/book1:batchUpdate');
    assert.equal(init.method, 'POST');
    assert.deepEqual(body, { requests: [{ addSheet: { properties: { title: 'Forecast', gridProperties: { rowCount: 500, columnCount: 12 } } } }] });
  });
  assert.equal((await run('add-tab', { spreadsheetId: 'book1', title: 'Forecast', rowCount: '500', columnCount: '12' })).items?.[0].sheetId, 0);
  mock({ spreadsheetId: 'book1' });
  await assert.rejects(run('add-tab', { spreadsheetId: 'book1', title: 'Forecast' }), /did not return the new tab ID/);
});

test('rename-tab updates only title, delete-tab addresses only the requested tab', async () => {
  const cases: { id: string; values: Record<string, string>; request: unknown }[] = [
    { id: 'rename-tab', values: { title: 'Annual report' }, request: { updateSheetProperties: { properties: { sheetId: 0, title: 'Annual report' }, fields: 'title' } } },
    { id: 'delete-tab', values: {}, request: { deleteSheet: { sheetId: 0 } } },
  ];
  for (const entry of cases) {
    mock({ spreadsheetId: 'book1', replies: [{}] }, (_url, _init, body) => assert.deepEqual(body.requests, [entry.request]));
    const result = await run(entry.id, { spreadsheetId: 'book1', sheetId: '0', ...entry.values });
    assert.equal(result.items?.[0].sheetId, 0);
  }
});

test('duplicate-tab returns the new tab rather than claiming the source ID was created', async () => {
  mock({ spreadsheetId: 'book1', replies: [{ duplicateSheet: { properties: { sheetId: 42, title: 'Copy' } } }] }, (_url, _init, body) => {
    assert.deepEqual(body.requests, [{ duplicateSheet: { sourceSheetId: 0, newSheetName: 'Copy' } }]);
  });
  assert.equal((await run('duplicate-tab', { spreadsheetId: 'book1', sheetId: '0', title: 'Copy' })).items?.[0].sheetId, 42);
});

test('format-cells constructs exact GridRange and leaf field masks to preserve other formatting', async () => {
  const range = { sheetId: 0, startRowIndex: 0, endRowIndex: 2, startColumnIndex: 1, endColumnIndex: 5 };
  const format = { textFormat: { bold: true }, numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' }, wrapStrategy: 'WRAP' };
  mock({ spreadsheetId: 'book1', replies: [{}] }, (_url, _init, body) => {
    assert.deepEqual(body.requests, [{ repeatCell: { range, cell: { userEnteredFormat: format }, fields: 'userEnteredFormat.textFormat.bold,userEnteredFormat.numberFormat.type,userEnteredFormat.numberFormat.pattern,userEnteredFormat.wrapStrategy' } }]);
  });
  await run('format-cells', { spreadsheetId: 'book1', gridRange: JSON.stringify(range), format: JSON.stringify(format) });
});

test('format-cells supports deliberate format replacement with *', async () => {
  mock({ spreadsheetId: 'book1', replies: [{}] }, (_url, _init, body) => {
    assert.equal(body.requests[0].repeatCell.fields, 'userEnteredFormat');
  });
  await run('format-cells', { spreadsheetId: 'book1', gridRange: '{"sheetId":0}', format: '{"textFormat":{"bold":true}}', fields: '*' });
});

test('advanced batch request exposes charts, pivots, validation, merges and formatting without translating away fields', async () => {
  const requests = [
    { addChart: { chart: { spec: { title: 'Revenue', basicChart: { chartType: 'COLUMN', axis: [{ position: 'BOTTOM_AXIS', title: 'Month' }] } }, position: { newSheet: true } } } },
    { updateCells: { start: { sheetId: 0, rowIndex: 0, columnIndex: 0 }, rows: [{ values: [{ pivotTable: { source: { sheetId: 1, startRowIndex: 0, endRowIndex: 100 } } }] }], fields: 'pivotTable' } },
    { setDataValidation: { range: { sheetId: 0, startColumnIndex: 2, endColumnIndex: 3 }, rule: { condition: { type: 'ONE_OF_LIST', values: [{ userEnteredValue: 'Approved' }] }, strict: true } } },
    { mergeCells: { range: { sheetId: 0, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 4 }, mergeType: 'MERGE_ALL' } },
  ];
  mock({ spreadsheetId: 'book1', replies: [{ addChart: { chart: { chartId: 77 } } }, {}, {}, {}] }, (_url, _init, body) => assert.deepEqual(body, { requests }));
  const result = await run('batch-update', { spreadsheetId: 'book1', requests: JSON.stringify(requests) });
  assert.match(result.summary, /accepted 4 spreadsheet requests atomically/);
  assert.equal(JSON.parse(String(result.items?.[0].replies))[0].addChart.chart.chartId, 77);
});

test('Sheets rejects oversized, invalid and unsafe destination inputs before issuing requests', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  const cases = [
    ['write-formulas', { spreadsheetId: 'https://evil.example/book', range: 'A1', values: '[[1]]' }],
    ['write-values', { spreadsheetId: 'book1', range: 'A1', values: '[null]' }],
    ['write-values', { spreadsheetId: 'book1', range: 'A1', values: '[[{}]]' }],
    ['write-values', { spreadsheetId: 'book1', range: 'A1', values: JSON.stringify(Array(101).fill([1])) }],
    ['write-values', { spreadsheetId: 'book1', range: 'A1', values: JSON.stringify([Array(101).fill(1)]) }],
    ['write-values', { spreadsheetId: 'book1', range: 'A1', values: '[[1]]', valueInputOption: 'UNSPECIFIED' }],
    ['read-spreadsheet', { spreadsheetId: 'book1', includeGridData: 'true' }],
    ['read-spreadsheet', { spreadsheetId: 'book1', ranges: '[{}]' }],
    ['rename-tab', { spreadsheetId: 'book1', sheetId: '-1', title: 'New' }],
    ['add-tab', { spreadsheetId: 'book1', title: 'New', rowCount: '0' }],
    ['format-cells', { spreadsheetId: 'book1', gridRange: '{"sheetId":0,"startRowIndex":3,"endRowIndex":2}', format: '{"textFormat":{"bold":true}}' }],
    ['format-cells', { spreadsheetId: 'book1', gridRange: '{"sheetId":0}', format: '{"textFormat":{"bold":true}}', fields: 'userEnteredFormat.textFormat.bold' }],
    ['batch-update', { spreadsheetId: 'book1', requests: '[{"addSheet":{},"deleteSheet":{}}]' }],
    ['batch-update', { spreadsheetId: 'book1', requests: '[]' }],
    ['batch-update', { spreadsheetId: 'book1', requests: JSON.stringify(Array(101).fill({ addSheet: {} })) }],
    ['batch-update', { spreadsheetId: 'book1', requests: '[{"method":"DELETE"}]' }],
    ['batch-update', { spreadsheetId: 'book1', requests: 'x'.repeat(500_001) }],
  ] as const;
  for (const [id, values] of cases) await assert.rejects(run(id, values), ProviderError);
  assert.equal(calls, 0);
});

test('Sheets supports bounded content above the former generic 50k limit', async () => {
  const values = JSON.stringify([['x'.repeat(30_000), 'y'.repeat(30_000)]]);
  mock({ updatedRange: 'A1:B1', updatedCells: 2 }, (_url, _init, body) => {
    assert.equal(body.values[0][0].length, 30_000);
    assert.equal(body.values[0][1].length, 30_000);
  });
  await run('write-values', { spreadsheetId: 'book1', range: 'A1:B1', values });
});

test('Sheets does not report successful mutations without confirmation or on provider errors', async () => {
  for (const body of [{}, { spreadsheetId: 'different-book' }, { spreadsheetId: 'book1', error: { message: 'provider error' } }]) {
    mock(body);
    await assert.rejects(run('rename-tab', { spreadsheetId: 'book1', sheetId: '0', title: 'Renamed' }), ProviderError);
  }
  globalThis.fetch = async () => Response.json({ error: { message: credential.accessToken } }, { status: 400 });
  await assert.rejects(run('batch-update', { spreadsheetId: 'book1', requests: '[{"unsupportedOperation":{}}]' }), error => error instanceof ProviderError && /HTTP 400/.test(error.message) && !error.message.includes(credential.accessToken));
});

test('oversized metadata results fail explicitly rather than returning truncated JSON', async () => {
  mock({ spreadsheetId: 'book1', sheets: [{ data: 'x'.repeat(200_000) }] });
  await assert.rejects(run('read-spreadsheet', { spreadsheetId: 'book1', ranges: '["Sheet1!A1"]', includeGridData: 'true' }), error => error instanceof ProviderError && error.status === 413 && /Narrow fields\/ranges/.test(error.message));
});

test('non-finite JSON numbers are rejected recursively before any Sheets operation', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const sign of ['', '-']) {
    await assert.rejects(run('batch-update', { spreadsheetId: 'book1', requests: `[{"updateCells":{"rows":[{"values":[{"userEnteredValue":{"numberValue":${sign}1e400}}]}]}}]` }), /finite numbers/);
    await assert.rejects(run('format-cells', { spreadsheetId: 'book1', gridRange: '{"sheetId":0}', format: `{"backgroundColor":{"red":${sign}1e400}}` }), /finite numbers/);
    await assert.rejects(run('write-formulas', { spreadsheetId: 'book1', range: 'A1', values: `[[${sign}1e400]]` }), /finite numbers/);
  }
  assert.equal(calls, 0);
});

test('grid-returning fields require ranges even when includeGridData is false', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const fields of ['*', 'sheets', 'spreadsheetId,sheets', 'sheets/*', 'sheets(data(rowData(values)))', 'sheets/data/rowData/values', 'sheets ( data (rowData(values)))']) {
    await assert.rejects(run('read-spreadsheet', { spreadsheetId: 'book1', fields, includeGridData: 'false' }), /Supply ranges/);
  }
  assert.equal(calls, 0);
  mock({ sheets: [{ charts: [{ chartId: 1 }] }] }, url => assert.equal(url.searchParams.get('fields'), 'sheets(properties,charts)'));
  await run('read-spreadsheet', { spreadsheetId: 'book1', fields: 'sheets(properties,charts)' });
});

test('oversized chunked Sheets responses cancel the reader without consuming the entire stream', async () => {
  for (const isWrite of [false, true]) {
    let cancelled = false; let pulls = 0;
    globalThis.fetch = async (_input, init) => {
      assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(128 * 1024).fill(32)); },
        cancel() { cancelled = true; },
      }), { headers: { 'content-type': 'application/json' } });
    };
    await assert.rejects(isWrite
      ? run('rename-tab', { spreadsheetId: 'book1', sheetId: '0', title: 'New' })
      : run('read-spreadsheet', { spreadsheetId: 'book1', fields: '*', ranges: '["Sheet1!A1"]' }), error => {
        assert.ok(error instanceof ProviderError);
        assert.equal(error.status, isWrite ? 502 : 413);
        assert.match(error.message, /exceeded 1 MiB/);
        assert.equal(error.message.includes('Google may have applied this write'), isWrite);
        return true;
      });
    assert.equal(cancelled, true); assert.ok(pulls <= 10, `Read ${pulls} chunks instead of stopping at the limit`);
  }
});

test('oversized content-length is rejected and response stream cancelled before reading', async () => {
  let cancelled = false; let pulls = 0;
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull() { pulls++; }, cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { headers: { 'content-length': String(1024 * 1024 + 1) } });
  await assert.rejects(run('read-values', { spreadsheetId: 'book1', range: 'A1' }), error => error instanceof ProviderError && error.status === 413);
  assert.equal(cancelled, true); assert.equal(pulls, 0);
});

test('oversized structured write replies retain uncertainty after a successful HTTP response', async () => {
  mock({ spreadsheetId: 'book1', replies: [{ findReplace: { details: 'x'.repeat(200_000) } }] });
  await assert.rejects(run('batch-update', { spreadsheetId: 'book1', requests: '[{"findReplace":{"find":"a","replacement":"b","allSheets":true}}]' }), error => error instanceof ProviderError && error.status === 502 && /may have applied this write/.test(error.message));
});

test('stream interruption and invalid JSON fail safely without echoing provider contents', async () => {
  for (const malformed of [false, true]) {
    globalThis.fetch = async () => malformed ? new Response(credential.accessToken) : new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error(credential.accessToken)); },
    }));
    await assert.rejects(run('rename-tab', { spreadsheetId: 'book1', sheetId: '0', title: 'New' }), error => error instanceof ProviderError && error.status === 502 && /may have applied this write/.test(error.message) && !error.message.includes(credential.accessToken));
  }
});

test('invalid local credentials fail before fetch and preserve a definite client failure', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(action('rename-tab').execute({ accessToken: 'invalid\ncredential' }, { spreadsheetId: 'book1', sheetId: '0', title: 'New' }, {}), error => error instanceof ProviderError && error.status === 400 && !/may have applied/.test(error.message));
  assert.equal(calls, 0);
});

test('explicit Google client rejections preserve statuses while server failures remain uncertain', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 503]) {
    globalThis.fetch = async () => Response.json({ error: { message: credential.accessToken } }, { status });
    await assert.rejects(run('rename-tab', { spreadsheetId: 'book1', sheetId: '0', title: 'New' }), error => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, status < 500 ? status : 502);
      assert.equal(/may have applied/.test(error.message), status >= 500);
      assert.equal(error.message.includes(credential.accessToken), false);
      return true;
    });
  }
});
