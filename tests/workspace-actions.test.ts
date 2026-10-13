import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { ActionValues } from '../server/action-types';
import { getWorkspaceAction, listWorkspaceActions, workspaceActions, workspaceApps } from '../server/workspace-actions';
import { ProviderError } from '../server/provider-types';
import { validateValues } from '../server/actions';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'workspace-private-token', fields: { mapsApiKey: 'private-maps-project-key' } };
function action(app: string, id: string) { const result = getWorkspaceAction(app, id); assert.ok(result); return result; }
const payload = (init?: RequestInit) => JSON.parse(String(init?.body)) as Record<string, any>;
function mock(body: unknown, inspect: (url: URL, init?: RequestInit) => void = () => {}, maps = false) {
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, 'error');
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    if (maps) {
      assert.equal(headers.get('authorization'), null);
      assert.equal(headers.get('x-goog-api-key'), credential.fields.mapsApiKey);
      assert.ok(headers.get('x-goog-fieldmask'));
    } else {
      assert.equal(headers.get('authorization'), `Bearer ${credential.accessToken}`);
      assert.equal(headers.get('x-goog-api-key'), null);
    }
    assert.equal(url.toString().includes(credential.accessToken), false);
    assert.equal(url.toString().includes(credential.fields.mapsApiKey), false);
    inspect(url, init);
    return Response.json(body);
  };
}

test('catalog gives each requested app its own actions, consent scopes and honest Maps/Voice limits', () => {
  assert.deepEqual(workspaceApps.map((app) => app.id).sort(), ['chat', 'docs', 'drive', 'gmail', 'maps', 'meet', 'sheets', 'slides', 'tasks', 'voice']);
  for (const app of workspaceApps) {
    assert.ok(listWorkspaceActions(app.id).length);
    assert.ok(app.docsUrl.startsWith('https://developers.google.com/'));
    assert.ok(listWorkspaceActions(app.id).every((definition) => ['read', 'write'].includes(definition.kind)));
  }
  assert.deepEqual(workspaceApps.find((app) => app.id === 'maps')?.scopes, []);
  assert.equal(workspaceApps.find((app) => app.id === 'maps')?.auth, 'api_key');
  assert.match(workspaceApps.find((app) => app.id === 'maps')!.description, /Personal saved places and Timeline are not available/);
  assert.deepEqual(workspaceApps.find((app) => app.id === 'voice')?.scopes, ['https://www.googleapis.com/auth/admin.reports.audit.readonly']);
  assert.ok(listWorkspaceActions('voice').every((definition) => definition.kind === 'read'));
  assert.match(workspaceApps.find((app) => app.id === 'voice')!.description, /Personal calls, SMS, and voicemail are not available/);
  assert.equal(getWorkspaceAction('gmail', 'create-document'), undefined);
  assert.equal(new Set(workspaceActions.map((entry) => `${entry.provider}:${entry.definition.id}`)).size, workspaceActions.length);
});

test('Sheets reads encoded A1 ranges and writes only literal bounded cell values', async () => {
  mock({ range: "My Sheet!A1:B2", values: [['a', 'b'], [1, true]] }, (url, init) => {
    assert.equal(url.origin, 'https://sheets.googleapis.com');
    assert.equal(decodeURIComponent(url.pathname), "/v4/spreadsheets/sheet123/values/'My Sheet'!A1:B2");
    assert.equal(url.searchParams.get('valueRenderOption'), 'FORMATTED_VALUE');
    assert.equal(init?.method, 'GET');
  });
  const result = await action('sheets', 'read-values').execute(credential, { spreadsheetId: 'sheet123', range: "'My Sheet'!A1:B2" }, {});
  assert.deepEqual(JSON.parse(String(result.items?.[1].values)), ['1', 'true']);
  mock({ updatedRange: 'Sheet1!A1:B1', updatedCells: 2 }, (url, init) => {
    assert.equal(init?.method, 'PUT'); assert.equal(url.searchParams.get('valueInputOption'), 'RAW');
    assert.deepEqual(payload(init), { range: 'Sheet1!A1:B1', majorDimension: 'ROWS', values: [['=IMPORTXML("bad")', 2]] });
  });
  assert.equal((await action('sheets', 'write-values').execute(credential, { spreadsheetId: 'sheet123', range: 'Sheet1!A1:B1', values: '[["=IMPORTXML(\\\"bad\\\")",2]]' }, {})).items?.[0].updatedCells, '2');
});

test('Docs reads text from tabs and appends only insertText at the end of the selected tab', async () => {
  mock({ documentId: 'doc123', title: 'Title', privateDebug: credential.accessToken, tabs: [{ documentTab: { body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Hello document\n' } }] } }] } } }] }, (url) => {
    assert.equal(url.origin, 'https://docs.googleapis.com'); assert.equal(url.searchParams.get('includeTabsContent'), 'true');
  });
  const result = await action('docs', 'read-document').execute(credential, { documentId: 'doc123' }, {});
  assert.equal(result.items?.[0].text, 'Hello document\n'); assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
  mock({ documentId: 'doc123' }, (url, init) => {
    assert.equal(url.pathname, '/v1/documents/doc123:batchUpdate');
    assert.deepEqual(payload(init), { requests: [{ insertText: { endOfSegmentLocation: { tabId: 't.0' }, text: 'More text' } }] });
  });
  await action('docs', 'append-text').execute(credential, { documentId: 'doc123', text: 'More text', tabId: 't.0', requests: '[{"deleteContentRange":{}}]' }, {});
});

test('Docs validation and appending preserve indentation, blank lines and newline-only additions', async () => {
  const append = action('docs', 'append-text');
  for (const text of ['\n  Indented paragraph\n\n', '\n']) {
    mock({ documentId: 'doc123' }, (_url, init) => {
      assert.equal(payload(init).requests[0].insertText.text, text);
    });
    const values = validateValues(append, { documentId: ' doc123 ', text });
    assert.equal(values.documentId, 'doc123');
    await append.execute(credential, values, {});
  }
});

test('Slides reads public text fields and sends an atomic create-slide plus two text requests', async () => {
  mock({ presentationId: 'presentation123', title: 'A deck', slides: [{ objectId: 'slide123', pageElements: [{ shape: { text: { textElements: [{ textRun: { content: 'Slide text' } }] } } }] }] });
  assert.equal((await action('slides', 'read-presentation').execute(credential, { presentationId: 'presentation123' }, {})).items?.[0].text, 'Slide text');
  mock({ presentationId: 'presentation123' }, (url, init) => {
    assert.equal(url.origin + url.pathname, 'https://slides.googleapis.com/v1/presentations/presentation123:batchUpdate');
    const requests = payload(init).requests;
    assert.equal(requests.length, 3);
    const create = requests[0].createSlide;
    assert.equal(create.slideLayoutReference.predefinedLayout, 'TITLE_AND_BODY');
    assert.deepEqual(requests[1].insertText, { objectId: create.placeholderIdMappings[0].objectId, insertionIndex: 0, text: 'A title' });
    assert.deepEqual(requests[2].insertText, { objectId: create.placeholderIdMappings[1].objectId, insertionIndex: 0, text: 'Body' });
  });
  await action('slides', 'add-text-slide').execute(credential, { presentationId: 'presentation123', title: 'A title', text: 'Body' }, {});
});

for (const item of [
  { app: 'sheets', action: 'create-spreadsheet', path: '/v4/spreadsheets', response: { spreadsheetId: 'new123' }, expected: { properties: { title: 'New file' } } },
  { app: 'docs', action: 'create-document', path: '/v1/documents', response: { documentId: 'new123' }, expected: { title: 'New file' } },
  { app: 'slides', action: 'create-presentation', path: '/v1/presentations', response: { presentationId: 'new123' }, expected: { title: 'New file' } },
]) test(`${item.app} creation verifies the official success identifier`, async () => {
  mock(item.response, (url, init) => { assert.equal(url.pathname, item.path); assert.equal(init?.method, 'POST'); assert.deepEqual(payload(init), item.expected); });
  const result = await action(item.app, item.action).execute(credential, { title: 'New file' }, {});
  assert.ok(result.link?.startsWith('https://docs.google.com/'));
  mock({});
  await assert.rejects(action(item.app, item.action).execute(credential, { title: 'New file' }, {}), /did not confirm/);
});

test('Gmail uses selected-user endpoints, pagination and bounded plain text decoding', async () => {
  mock({ messages: [{ id: 'abc123', threadId: 'thread123', debug: credential.accessToken }], nextPageToken: 'next-page' }, (url) => {
    assert.equal(url.origin + url.pathname, 'https://gmail.googleapis.com/gmail/v1/users/me/messages');
    assert.equal(url.searchParams.get('q'), 'from:example@example.com'); assert.equal(url.searchParams.get('pageToken'), 'previous-page');
  });
  const listed = await action('gmail', 'list-messages').execute(credential, { query: 'from:example@example.com', pageToken: 'previous-page' }, {});
  assert.equal(listed.items?.[1].nextPageToken, 'next-page'); assert.equal(JSON.stringify(listed).includes(credential.accessToken), false);
  mock({ id: 'abc123', threadId: 'thread123', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'someone@example.com' }, { name: 'Subject', value: 'Hi' }], parts: [{ mimeType: 'text/html', body: { data: Buffer.from('<p>html</p>').toString('base64url') } }, { mimeType: 'text/plain', body: { data: Buffer.from('Mail text ✓').toString('base64url') } }] } }, (url) => { assert.equal(url.pathname, '/gmail/v1/users/me/messages/abc123'); assert.equal(url.searchParams.get('format'), 'full'); });
  const read = await action('gmail', 'read-message').execute(credential, { messageId: 'abc123' }, {});
  assert.match(String(read.items?.[0].text), /Mail text ✓/); assert.equal(read.items?.[0].subject, 'Hi'); assert.equal(JSON.stringify(read).includes('<p>'), false);
});

for (const operation of ['create-draft', 'send-email']) test(`Gmail ${operation} builds injection-resistant UTF-8 MIME with the expected endpoint`, async () => {
  const values = { to: 'one@example.com, two@example.com', subject: 'A Unicode subject ✓', text: '\n  Hello\nWorld ✓\n\n' };
  mock(operation === 'create-draft' ? { id: 'draft123', message: { id: 'mail123' } } : { id: 'mail123', threadId: 'thread123' }, (url, init) => {
    assert.equal(url.pathname, `/gmail/v1/users/me/${operation === 'create-draft' ? 'drafts' : 'messages/send'}`);
    assert.equal(init?.method, 'POST');
    const sent = payload(init); const raw = operation === 'create-draft' ? sent.message.raw : sent.raw;
    const mime = Buffer.from(raw, 'base64url').toString();
    assert.ok(mime.startsWith('To: one@example.com,\r\n two@example.com\r\nSubject: =?UTF-8?B?'));
    assert.ok(mime.includes('Content-Type: text/plain; charset=UTF-8'));
    assert.equal(Buffer.from(mime.split('\r\n\r\n')[1], 'base64').toString(), values.text);
    assert.equal(Object.hasOwn(sent, 'userId'), false);
  });
  const adapter = action('gmail', operation);
  await adapter.execute(credential, validateValues(adapter, values), {});
});

test('Gmail rejects header injection and oversized/invalid recipients before sending', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  for (const invalid of [
    { to: 'ok@example.com\r\nBcc: attack@example.com' }, { subject: 'Hello\nBcc: bad@example.com' },
    { to: 'Person <ok@example.com>' }, { to: 'x'.repeat(65) + '@example.com' }, { to: Array(21).fill('a@example.com').join(',') },
  ]) await assert.rejects(action('gmail', 'send-email').execute(credential, { to: 'ok@example.com', subject: 'Hello', text: 'Body', ...invalid }, {}), ProviderError);
  assert.equal(calls, 0);
});

test('Drive escapes search literals and creates only requested folders or plain text uploads', async () => {
  mock({ files: [{ id: 'file123', name: 'Doc', mimeType: 'text/plain' }] }, (url) => {
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/drive/v3/files');
    assert.equal(url.searchParams.get('q'), "trashed = false and name contains 'O\\'Reilly\\\\file'");
    assert.equal(url.searchParams.get('pageSize'), '50');
  });
  assert.equal((await action('drive', 'list-files').execute(credential, { nameContains: "O'Reilly\\file" }, {})).items?.[0].fileId, 'file123');
  mock({ id: 'file123', name: 'File', parents: ['folder123'] }, (url) => { assert.equal(url.pathname, '/drive/v3/files/file123'); assert.equal(url.searchParams.has('alt'), false); });
  assert.equal((await action('drive', 'read-file-metadata').execute(credential, { fileId: 'file123' }, {})).items?.[0].parents, 'folder123');
  mock({ id: 'folder123', name: 'New folder' }, (_url, init) => { assert.deepEqual(payload(init), { name: 'New folder', mimeType: 'application/vnd.google-apps.folder', parents: ['parent123'] }); });
  await action('drive', 'create-folder').execute(credential, { title: 'New folder', parentId: 'parent123' }, {});
  mock({ id: 'file123', name: 'File.txt' }, (url, init) => {
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/upload/drive/v3/files'); assert.equal(url.searchParams.get('uploadType'), 'multipart');
    const content = String(init?.body); assert.ok(content.includes('Content-Type: text/plain; charset=UTF-8\r\n\r\nText file body'));
    assert.ok(content.includes('"parents":["parent123"]')); assert.ok(content.includes('"mimeType":"text/plain"'));
  });
  await action('drive', 'create-text-file').execute(credential, { title: 'File.txt', parentId: 'parent123', text: 'Text file body' }, {});
});

test('Meet creates meeting spaces and reads records without sending invitations', async () => {
  mock({ name: 'spaces/meet123', meetingUri: 'https://meet.google.com/abc-defg-hij', meetingCode: 'abc-defg-hij' }, (url, init) => { assert.equal(url.origin + url.pathname, 'https://meet.googleapis.com/v2/spaces'); assert.equal(init?.method, 'POST'); assert.deepEqual(payload(init), {}); });
  assert.equal((await action('meet', 'create-meeting').execute(credential, {}, {})).items?.[0].name, 'spaces/meet123');
  mock({ name: 'spaces/meet123', activeConference: { conferenceRecord: 'conferenceRecords/record123' } }, (url) => { assert.equal(url.pathname, '/v2/spaces/abc-defg-hij'); });
  assert.equal((await action('meet', 'read-space').execute(credential, { spaceId: 'abc-defg-hij' }, {})).items?.[0].activeConference, 'conferenceRecords/record123');
  mock({ conferenceRecords: [{ name: 'conferenceRecords/record123', space: 'spaces/meet123', startTime: '2026-10-14T01:00:00Z' }] }, (url) => { assert.equal(url.pathname, '/v2/conferenceRecords'); assert.equal(url.searchParams.get('pageSize'), '25'); });
  assert.equal((await action('meet', 'list-conferences').execute(credential, {}, {})).items?.[0].space, 'spaces/meet123');
});

test('Chat scopes user requests to explicit validated spaces and returns only message fields', async () => {
  mock({ spaces: [{ name: 'spaces/AAA123', displayName: 'Team', spaceType: 'SPACE' }] }, (url) => { assert.equal(url.origin + url.pathname, 'https://chat.googleapis.com/v1/spaces'); });
  assert.equal((await action('chat', 'list-spaces').execute(credential, {}, {})).items?.[0].name, 'spaces/AAA123');
  mock({ messages: [{ name: 'spaces/AAA123/messages/msg123', sender: { name: 'users/123' }, text: 'Hello', privateDebug: credential.accessToken }] }, (url) => { assert.equal(url.pathname, '/v1/spaces/AAA123/messages'); assert.equal(url.searchParams.get('orderBy'), 'createTime desc'); });
  const messages = await action('chat', 'list-messages').execute(credential, { spaceId: 'AAA123' }, {});
  assert.equal(messages.items?.[0].text, 'Hello'); assert.equal(JSON.stringify(messages).includes(credential.accessToken), false);
  mock({ name: 'spaces/AAA123/messages/new123' }, (_url, init) => { assert.equal(init?.method, 'POST'); assert.deepEqual(payload(init), { text: 'Reply' }); });
  await action('chat', 'send-message').execute(credential, { spaceId: 'AAA123', text: 'Reply' }, {});
});

test('Tasks lists, creates and updates tasks with date-only due values and verifies completion', async () => {
  mock({ items: [{ id: 'list123', title: 'List' }] }, (url) => { assert.equal(url.origin + url.pathname, 'https://tasks.googleapis.com/tasks/v1/users/@me/lists'); });
  assert.equal((await action('tasks', 'list-tasklists').execute(credential, {}, {})).items?.[0].tasklistId, 'list123');
  mock({ items: [{ id: 'task123', title: 'Task', status: 'needsAction' }] }, (url) => { assert.equal(url.pathname, '/tasks/v1/lists/list123/tasks'); assert.equal(url.searchParams.get('showHidden'), 'true'); });
  assert.equal((await action('tasks', 'list-tasks').execute(credential, { tasklistId: 'list123' }, {})).items?.[0].taskId, 'task123');
  for (const operation of ['create-task', 'update-task']) {
    mock({ id: 'task123', title: 'Do work', due: '2026-10-14T00:00:00Z' }, (_url, init) => { assert.equal(init?.method, operation === 'create-task' ? 'POST' : 'PATCH'); assert.deepEqual(payload(init), { title: 'Do work', notes: 'Notes', due: '2026-10-14T00:00:00Z' }); });
    await action('tasks', operation).execute(credential, { tasklistId: 'list123', taskId: 'task123', title: 'Do work', notes: 'Notes', dueDate: '2026-10-14' }, {});
  }
  mock({ id: 'task123', title: 'Renamed' }, (_url, init) => { assert.deepEqual(payload(init), { title: 'Renamed' }); });
  const update = action('tasks', 'update-task');
  await update.execute(credential, validateValues(update, { tasklistId: 'list123', taskId: 'task123', title: 'Renamed' }), {});
  mock({ id: 'task123', status: 'completed' }, (_url, init) => { assert.equal(init?.method, 'PATCH'); assert.deepEqual(payload(init), { status: 'completed' }); });
  await action('tasks', 'complete-task').execute(credential, { tasklistId: 'list123', taskId: 'task123' }, {});
  mock({ id: 'task123', status: 'needsAction' });
  await assert.rejects(action('tasks', 'complete-task').execute(credential, { tasklistId: 'list123', taskId: 'task123' }, {}), /did not confirm/);
});

test('Voice reads only the official Workspace administrator audit endpoint', async () => {
  mock({ items: [{ id: { time: '2026-10-14T01:00:00Z' }, actor: { email: 'admin@example.com' }, events: [{ name: 'call_event', parameters: [{ secret: credential.accessToken }] }] }] }, (url, init) => {
    assert.equal(url.origin + url.pathname, 'https://admin.googleapis.com/admin/reports/v1/activity/users/user%40example.com/applications/voice'); assert.equal(url.searchParams.get('maxResults'), '25'); assert.equal(init?.method, 'GET');
  });
  const result = await action('voice', 'list-audit-events').execute(credential, { userEmail: 'user@example.com' }, {});
  assert.equal(result.items?.[0].events, 'call_event'); assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
});

test('Maps Places New uses only the selected billing key and explicit billable fields', async () => {
  const place = { id: 'ChIJ123', displayName: { text: 'Coffee shop' }, formattedAddress: '123 Main St', location: { latitude: 25, longitude: 121 }, googleMapsUri: 'https://maps.google.com/maps?cid=123', debug: credential.fields.mapsApiKey };
  mock({ places: [place] }, (url, init) => { assert.equal(url.toString(), 'https://places.googleapis.com/v1/places:searchText'); assert.deepEqual(payload(init), { textQuery: 'Coffee Taipei', pageSize: 20 }); assert.equal(new Headers(init?.headers).get('x-goog-fieldmask'), 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri'); }, true);
  const result = await action('maps', 'search-places').execute(credential, { query: 'Coffee Taipei' }, {});
  assert.equal(result.items?.[0].latitude, 25); assert.equal(JSON.stringify(result).includes(credential.fields.mapsApiKey), false);
  mock(place, (url, init) => { assert.equal(url.toString(), 'https://places.googleapis.com/v1/places/ChIJ123'); assert.equal(init?.method, 'GET'); }, true);
  assert.equal((await action('maps', 'read-place').execute(credential, { placeId: 'ChIJ123' }, {})).items?.[0].name, 'Coffee shop');
});

test('Workspace validates path IDs, cell data, dates and keys without external requests', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; return Response.json({}); };
  const invalid: [string, string, ActionValues][] = [
    ['docs', 'read-document', { documentId: '../other?token=x' }], ['slides', 'read-presentation', { presentationId: 'https://evil.example' }],
    ['chat', 'send-message', { spaceId: 'AAA/messages/x', text: 'Hi' }], ['drive', 'create-folder', { title: 'Folder', parentId: '../parent' }],
    ['gmail', 'read-message', { messageId: '../../other' }], ['meet', 'read-space', { spaceId: '../../users' }],
    ['sheets', 'write-values', { spreadsheetId: 'sheet123', range: 'A1', values: '[[{"bad":1}]]' }],
    ['tasks', 'create-task', { tasklistId: 'list123', title: 'Task', dueDate: '2026-02-30' }],
    ['voice', 'list-audit-events', { userEmail: 'bad@example.com/../../all' }], ['maps', 'read-place', { placeId: '../x' }],
  ];
  for (const [app, operation, values] of invalid) await assert.rejects(action(app, operation).execute(credential, values, {}), ProviderError);
  await assert.rejects(action('maps', 'search-places').execute({ accessToken: credential.accessToken }, { query: 'Coffee' }, {}), /project API key/);
  assert.equal(calls, 0);
});

test('upstream failures and token-bearing exception details never reach callers', async () => {
  for (const status of [401, 403, 429, 500]) {
    globalThis.fetch = async () => Response.json({ error: { message: credential.accessToken } }, { status });
    await assert.rejects(action('gmail', 'send-email').execute(credential, { to: 'a@example.com', subject: 'Subject', text: 'Text' }, {}), (error: unknown) => {
      assert.ok(error instanceof ProviderError); assert.equal(error.message.includes(credential.accessToken), false); return true;
    });
  }
  globalThis.fetch = async () => { throw new Error(credential.fields.mapsApiKey); };
  await assert.rejects(action('maps', 'search-places').execute(credential, { query: 'Place' }, {}), (error: unknown) => { assert.ok(error instanceof ProviderError); assert.equal(error.message.includes(credential.fields.mapsApiKey), false); return true; });
  mock({ error: { message: credential.accessToken }, id: 'fake123' });
  await assert.rejects(action('gmail', 'create-draft').execute(credential, { to: 'a@example.com', subject: 'Subject', text: 'Text' }, {}), /failed operation/);
});
