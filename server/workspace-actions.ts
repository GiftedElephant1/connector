import { randomUUID } from 'node:crypto';
import { apiJson, bearer, records, required, string } from './action-http';
import type { ActionAdapter, ActionDefinition, ActionField, ActionResult, ActionValues } from './action-types';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';
import { downloadDriveFile } from './workspace-drive-download';

export type WorkspaceApp = {
  id: string;
  name: string;
  description: string;
  available: boolean;
  auth: 'oauth' | 'api_key' | 'unsupported';
  scopes: string[];
  /** Request on consent without disabling legacy actions on older grants. */
  additionalScopes?: string[];
  docsUrl: string;
};
const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
/** App consent is independent for each connected Google identity. Maps keys belong to billing projects. */
export const workspaceApps: WorkspaceApp[] = [
  { id: 'sheets', name: 'Google Sheets', description: 'Read and update cells, and create spreadsheets.', available: true, auth: 'oauth', scopes: [scope('spreadsheets')], docsUrl: 'https://developers.google.com/workspace/sheets/api/reference/rest' },
  { id: 'docs', name: 'Google Docs', description: 'Read and create documents, and append text.', available: true, auth: 'oauth', scopes: [scope('documents')], docsUrl: 'https://developers.google.com/workspace/docs/api/reference/rest' },
  { id: 'slides', name: 'Google Slides', description: 'Read and create presentations, and add text slides.', available: true, auth: 'oauth', scopes: [scope('presentations')], docsUrl: 'https://developers.google.com/workspace/slides/api/reference/rest' },
  { id: 'gmail', name: 'Gmail', description: 'Search and read messages, create drafts, and send plain-text email.', available: true, auth: 'oauth', scopes: [scope('gmail.readonly'), scope('gmail.compose')], docsUrl: 'https://developers.google.com/workspace/gmail/api/reference/rest' },
  { id: 'drive', name: 'Google Drive', description: 'Search files, download logos and other stored files up to 20 MiB, and create folders or text files. Downloads require permission to read existing Drive files.', available: true, auth: 'oauth', scopes: [scope('drive.metadata.readonly'), scope('drive.file')], additionalScopes: [scope('drive.readonly')], docsUrl: 'https://developers.google.com/workspace/drive/api/reference/rest/v3' },
  { id: 'maps', name: 'Google Maps', description: 'Read-only Places integration: search public places and read their details using a billing-enabled Google Cloud project key. Personal saved places and Timeline are not available. The Places API does not offer writes to these account features.', available: true, auth: 'api_key', scopes: [], docsUrl: 'https://developers.google.com/maps/documentation/places/web-service/overview' },
  { id: 'meet', name: 'Google Meet', description: 'Create meeting links, read meeting spaces, and list accessible conference records. Requires an eligible Google Workspace account.', available: true, auth: 'oauth', scopes: [scope('meetings.space.created'), scope('meetings.space.readonly')], docsUrl: 'https://developers.google.com/workspace/meet/api/reference/rest' },
  { id: 'voice', name: 'Google Voice', description: 'Read-only administrator audit reports. Personal calls, SMS, and voicemail are not available through the official API. The audit API cannot place calls or send messages.', available: true, auth: 'oauth', scopes: [scope('admin.reports.audit.readonly')], docsUrl: 'https://developers.google.com/workspace/admin/reports/v1/appendix/activity/voice' },
  { id: 'chat', name: 'Google Chat', description: 'List spaces and messages, and send text messages as the selected user. Requires an eligible Chat account and Google Chat API configuration.', available: true, auth: 'oauth', scopes: [scope('chat.spaces.readonly'), scope('chat.messages.readonly'), scope('chat.messages.create')], docsUrl: 'https://developers.google.com/workspace/chat/api/reference/rest' },
  { id: 'tasks', name: 'Google Tasks', description: 'List task lists and tasks, create tasks, and mark tasks complete.', available: true, auth: 'oauth', scopes: [scope('tasks')], docsUrl: 'https://developers.google.com/workspace/tasks/reference/rest' },
];

const origins = {
  sheets: 'https://sheets.googleapis.com/v4', docs: 'https://docs.googleapis.com/v1',
  slides: 'https://slides.googleapis.com/v1', gmail: 'https://gmail.googleapis.com/gmail/v1/users/me',
  drive: 'https://www.googleapis.com/drive/v3', meet: 'https://meet.googleapis.com/v2',
  chat: 'https://chat.googleapis.com/v1', tasks: 'https://tasks.googleapis.com/tasks/v1',
  voice: 'https://admin.googleapis.com/admin/reports/v1',
};
type OAuthApp = keyof typeof origins;
const field = (name: string, label: string, required = true, type: ActionField['type'] = 'text'): ActionField => ({ name, label, required, type });
const pageField = field('pageToken', 'Next page token (optional)', false);
const titleField = field('title', 'Title');
const textField: ActionField = { ...field('text', 'Plain text', true, 'textarea'), preserveWhitespace: true };
const notesField: ActionField = { ...field('notes', 'Notes (optional)', false, 'textarea'), preserveWhitespace: true };
const fileField = field('fileId', 'File ID');
const documentField = field('documentId', 'Document ID');
const spreadsheetField = field('spreadsheetId', 'Spreadsheet ID');
const presentationField = field('presentationId', 'Presentation ID');
const rangeField: ActionField = { ...field('range', 'A1 cell range'), placeholder: 'Sheet1!A1:C10' };
const tasklistField = field('tasklistId', 'Task list ID');
const spaceField = field('spaceId', 'Space ID (without spaces/ prefix)');

function bounded(values: ActionValues, key: string, max = 1000, optional = false): string {
  const result = optional ? values[key]?.trim() ?? '' : required(values, key);
  if (result.length > max || result.includes('\0')) throw new ProviderError(`${key} must contain at most ${max} characters without null bytes.`);
  return result;
}
function content(values: ActionValues, key: string, max: number, optional = false): string {
  const result = values[key] ?? '';
  if (!optional && !result) throw new ProviderError(`${key} is required.`);
  if (result.length > max || result.includes('\0')) throw new ProviderError(`${key} must contain at most ${max} characters without null bytes.`);
  return result;
}
function id(values: ActionValues, key: string): string {
  const result = required(values, key);
  if (!/^[A-Za-z0-9_-]{1,250}={0,2}$/.test(result)) throw new ProviderError(`${key} must be an ID, without a URL or path.`);
  return encodeURIComponent(result);
}
function query(values: ActionValues, base: Record<string, string>): string {
  const params = new URLSearchParams(base);
  const pageToken = bounded(values, 'pageToken', 3000, true);
  if (pageToken) params.set('pageToken', pageToken);
  return params.toString();
}
function obj(value: unknown): Record<string, unknown> { return isObject(value) ? value : {}; }
function confirmed(body: Record<string, unknown>, key: string): string {
  if (body.error !== undefined) throw new ProviderError('Google reported a failed operation. Check the app before retrying a write.', 502);
  const result = string(body[key]);
  if (!result) throw new ProviderError('Google did not confirm this operation. Check the app before retrying a write.', 502);
  return result;
}
function paged(summary: string, items: NonNullable<ActionResult['items']>, body: Record<string, unknown>): ActionResult {
  const nextPageToken = string(body.nextPageToken);
  return { summary: `${summary}${nextPageToken ? ' More results are available; use the next page token.' : ''}`, items: [...items, ...(nextPageToken ? [{ nextPageToken }] : [])] };
}
async function request(app: OAuthApp, path: string, credential: Credential, method = 'GET', body?: unknown) {
  const result = await apiJson(workspaceApps.find((entry) => entry.id === app)!.name, `${origins[app]}${path}`, {
    method, headers: { ...bearer(credential), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (result.error !== undefined) throw new ProviderError('Google reported a failed operation. Check the app before retrying a write.', 502);
  return result;
}
function adapter(app: string, id: string, label: string, kind: 'read' | 'write', description: string, fields: ActionField[], execute: ActionAdapter['execute']): ActionAdapter {
  return { provider: app, definition: { id, label, kind, group: ['gmail', 'chat'].includes(app) ? 'inbox' : 'publishing', description, fields }, execute };
}

/** Only plain text runs are returned from Docs; nested tables and tabs are traversed with a size/depth bound. */
function documentText(value: unknown, depth = 0): string {
  if (depth > 18) return '';
  if (Array.isArray(value)) {
    let result = '';
    for (const entry of value.slice(0, 2000)) {
      result += documentText(entry, depth + 1);
      if (result.length >= 60_000) break;
    }
    return result.slice(0, 60_000);
  }
  if (!isObject(value)) return '';
  if (isObject(value.textRun) && typeof value.textRun.content === 'string') return value.textRun.content.slice(0, 60_000);
  return documentText(['body', 'content', 'paragraph', 'elements', 'table', 'tableRows', 'tableCells', 'tabs', 'documentTab', 'childTabs'].flatMap((key) => value[key] === undefined ? [] : [value[key]]), depth + 1);
}
function mailText(payload: unknown, depth = 0): string {
  const part = obj(payload);
  if (depth > 10) return '';
  const body = obj(part.body);
  if (part.mimeType === 'text/plain' && typeof body.data === 'string') {
    // Attachments are never downloaded; Gmail embeds only smaller bodies in this response.
    return Buffer.from(body.data.slice(0, 90_000), 'base64url').toString('utf8').slice(0, 60_000);
  }
  return records(part.parts).map((child) => mailText(child, depth + 1)).join('\n').slice(0, 60_000);
}
function email(values: ActionValues): string {
  const to = bounded(values, 'to', 2000);
  const recipients = to.split(',').map((value) => value.trim());
  if (recipients.length > 20 || recipients.some((value) => value.length > 254 || value.split('@')[0].length > 64 || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/.test(value))) {
    throw new ProviderError('Enter up to 20 email addresses separated by commas, without display names or line breaks.');
  }
  const subject = bounded(values, 'subject', 250);
  if (/[\r\n]/.test(subject)) throw new ProviderError('Email subjects cannot contain line breaks.');
  const text = content(values, 'text', 60_000);
  const encodedText = Buffer.from(text, 'utf8').toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '';
  const encodedSubject = [...subject].reduce<string[]>((chunks, character) => {
    const last = chunks.length - 1;
    if (last < 0 || Buffer.byteLength(chunks[last] + character) > 39) chunks.push(character);
    else chunks[last] += character;
    return chunks;
  }, []).map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`).join('\r\n ');
  return Buffer.from(`To: ${recipients.join(',\r\n ')}\r\nSubject: ${encodedSubject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encodedText}\r\n`).toString('base64url');
}
const mailFields = [field('to', 'Recipient email addresses'), field('subject', 'Subject'), textField];
const driveFields = 'id,name,mimeType,modifiedTime,webViewLink,parents';

export const workspaceActions: ActionAdapter[] = [
  adapter('sheets', 'read-values', 'Read cells', 'read', 'Read up to 100 rows from an A1 range. Cells are returned as displayed text.', [spreadsheetField, rangeField], async (credential, values) => {
    const body = await request('sheets', `/spreadsheets/${id(values, 'spreadsheetId')}/values/${encodeURIComponent(bounded(values, 'range', 300))}?valueRenderOption=FORMATTED_VALUE`, credential);
    const rows = Array.isArray(body.values) ? body.values.slice(0, 100).filter(Array.isArray) : [];
    return { summary: `Read ${rows.length} rows from ${string(body.range)} (at most 100 rows and 100 cells per row).`, items: rows.map((row, index) => ({ rowOffset: index, values: JSON.stringify(row.slice(0, 100).map((cell: unknown) => typeof cell === 'boolean' ? String(cell) : string(cell))) })) };
  }),
  adapter('sheets', 'write-values', 'Write cells', 'write', 'Overwrite cells in an A1 range with a JSON array of rows. Values are stored literally; formulas are not evaluated.', [spreadsheetField, rangeField, field('values', 'Rows as JSON', true, 'textarea')], async (credential, values) => {
    const spreadsheetId = id(values, 'spreadsheetId'); const range = bounded(values, 'range', 300);
    let rows: unknown;
    try { rows = JSON.parse(bounded(values, 'values', 100_000)); } catch { throw new ProviderError('values must be a JSON array of rows.'); }
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100 || rows.some((row) => !Array.isArray(row) || row.length < 1 || row.length > 100 || row.some((cell) => !['string', 'number', 'boolean'].includes(typeof cell) || typeof cell === 'number' && !Number.isFinite(cell)))) throw new ProviderError('Supply 1–100 rows of 1–100 string, number, or boolean cells.');
    const body = await request('sheets', `/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`, credential, 'PUT', { range, majorDimension: 'ROWS', values: rows });
    return { summary: 'Updated spreadsheet cells.', items: [{ range: confirmed(body, 'updatedRange'), updatedCells: string(body.updatedCells) }] };
  }),
  adapter('sheets', 'create-spreadsheet', 'Create spreadsheet', 'write', 'Create an empty spreadsheet in the selected account.', [titleField], async (credential, values) => {
    const body = await request('sheets', '/spreadsheets', credential, 'POST', { properties: { title: bounded(values, 'title', 200) } });
    const spreadsheetId = confirmed(body, 'spreadsheetId');
    return { summary: 'Created spreadsheet.', items: [{ spreadsheetId }], link: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/edit` };
  }),
  adapter('docs', 'read-document', 'Read document', 'read', 'Read document title and up to 60,000 characters of text, including tabs. Images and formatting are omitted.', [documentField], async (credential, values) => {
    const body = await request('docs', `/documents/${id(values, 'documentId')}?includeTabsContent=true`, credential);
    return { summary: 'Read document text (up to 60,000 characters).', items: [{ documentId: string(body.documentId), title: string(body.title), text: documentText(body) }] };
  }),
  adapter('docs', 'create-document', 'Create document', 'write', 'Create an empty Google document. Use append-text to add its contents.', [titleField], async (credential, values) => {
    const body = await request('docs', '/documents', credential, 'POST', { title: bounded(values, 'title', 200) });
    const documentId = confirmed(body, 'documentId');
    return { summary: 'Created document.', items: [{ documentId }], link: `https://docs.google.com/document/d/${encodeURIComponent(documentId)}/edit` };
  }),
  adapter('docs', 'append-text', 'Append document text', 'write', 'Append plain text to a document body. For documents with tabs, provide a tab ID or use the first tab.', [documentField, textField, field('tabId', 'Tab ID (optional)', false)], async (credential, values) => {
    const documentId = id(values, 'documentId'); const text = content(values, 'text', 60_000);
    const tabId = bounded(values, 'tabId', 250, true);
    if (tabId && !/^[A-Za-z0-9_.-]+$/.test(tabId)) throw new ProviderError('tabId must be a Google Docs tab identifier.');
    const endOfSegmentLocation = tabId ? { tabId } : {};
    const body = await request('docs', `/documents/${documentId}:batchUpdate`, credential, 'POST', { requests: [{ insertText: { endOfSegmentLocation, text } }] });
    return { summary: 'Appended document text.', items: [{ documentId: confirmed(body, 'documentId') }] };
  }),
  adapter('slides', 'read-presentation', 'Read presentation', 'read', 'Read the presentation title and text in up to 100 slides. Images, tables and notes are omitted.', [presentationField], async (credential, values) => {
    const body = await request('slides', `/presentations/${id(values, 'presentationId')}`, credential);
    return { summary: `Read ${string(body.title)} (up to 100 slides).`, items: records(body.slides).map((slide) => ({ slideId: string(slide.objectId), text: records(slide.pageElements).map((element) => records(obj(obj(element.shape).text).textElements).map((run) => string(obj(run.textRun).content)).join('')).join('\n').slice(0, 20_000) })) };
  }),
  adapter('slides', 'create-presentation', 'Create presentation', 'write', 'Create an empty presentation in the selected account.', [titleField], async (credential, values) => {
    const body = await request('slides', '/presentations', credential, 'POST', { title: bounded(values, 'title', 200) });
    const presentationId = confirmed(body, 'presentationId');
    return { summary: 'Created presentation.', items: [{ presentationId }], link: `https://docs.google.com/presentation/d/${encodeURIComponent(presentationId)}/edit` };
  }),
  adapter('slides', 'add-text-slide', 'Add text slide', 'write', 'Append a slide with a title and body text using the standard title-and-body layout.', [presentationField, titleField, textField], async (credential, values) => {
    const presentationId = id(values, 'presentationId'); const title = bounded(values, 'title', 500); const text = content(values, 'text', 20_000);
    const slideId = `connector_${randomUUID().replaceAll('-', '')}`; const titleId = `${slideId}_title`; const bodyId = `${slideId}_body`;
    const body = await request('slides', `/presentations/${presentationId}:batchUpdate`, credential, 'POST', { requests: [
      { createSlide: { objectId: slideId, slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' }, placeholderIdMappings: [{ layoutPlaceholder: { type: 'TITLE', index: 0 }, objectId: titleId }, { layoutPlaceholder: { type: 'BODY', index: 0 }, objectId: bodyId }] } },
      { insertText: { objectId: titleId, insertionIndex: 0, text: title } }, { insertText: { objectId: bodyId, insertionIndex: 0, text } },
    ] });
    return { summary: 'Added a text slide.', items: [{ presentationId: confirmed(body, 'presentationId'), slideId }] };
  }),
  adapter('gmail', 'list-messages', 'Search mail', 'read', 'List up to 25 message IDs matching an optional Gmail search query. Use read-message for the message content.', [field('query', 'Gmail search query (optional)', false), pageField], async (credential, values) => {
    const body = await request('gmail', `/messages?${query(values, { maxResults: '25', q: bounded(values, 'query', 1000, true) })}`, credential);
    return paged('Listed matching message IDs.', records(body.messages).map((message) => ({ messageId: string(message.id), threadId: string(message.threadId) })), body);
  }),
  adapter('gmail', 'read-message', 'Read mail', 'read', 'Read message headers and up to 60,000 characters of plain text. Attachments are not downloaded; HTML-only messages include a snippet.', [field('messageId', 'Message ID')], async (credential, values) => {
    const body = await request('gmail', `/messages/${id(values, 'messageId')}?format=full`, credential); const payload = obj(body.payload);
    const headers = records(payload.headers); const header = (name: string) => string(headers.find((entry) => string(entry.name).toLowerCase() === name)?.value);
    return { summary: 'Read email message.', items: [{ messageId: string(body.id), threadId: string(body.threadId), from: header('from'), to: header('to'), subject: header('subject'), date: header('date'), text: mailText(payload) || string(body.snippet), snippet: string(body.snippet) }] };
  }),
  adapter('gmail', 'create-draft', 'Create email draft', 'write', 'Save a plain-text email draft in the selected account. This does not send the email.', mailFields, async (credential, values) => {
    const body = await request('gmail', '/drafts', credential, 'POST', { message: { raw: email(values) } });
    return { summary: 'Saved an email draft. It has not been sent.', items: [{ draftId: confirmed(body, 'id'), messageId: string(obj(body.message).id) }] };
  }),
  adapter('gmail', 'send-email', 'Send email', 'write', 'Send a plain-text email immediately from the selected account. Requires write confirmation and an idempotency key.', mailFields, async (credential, values) => {
    const body = await request('gmail', '/messages/send', credential, 'POST', { raw: email(values) });
    return { summary: 'Gmail accepted the email for sending.', items: [{ messageId: confirmed(body, 'id'), threadId: string(body.threadId) }] };
  }),
  adapter('drive', 'list-files', 'Search Drive files', 'read', 'List up to 50 non-deleted files, optionally filtering by a name fragment. Returns metadata only.', [field('nameContains', 'File name contains (optional)', false), pageField], async (credential, values) => {
    const name = bounded(values, 'nameContains', 250, true).replaceAll('\\', '\\\\').replaceAll("'", "\\'");
    const body = await request('drive', `/files?${query(values, { pageSize: '50', q: `trashed = false${name ? ` and name contains '${name}'` : ''}`, fields: `nextPageToken,files(${driveFields})`, spaces: 'drive' })}`, credential);
    return paged('Listed Drive file metadata.', records(body.files).map(driveFile), body);
  }),
  adapter('drive', 'read-file-metadata', 'Read Drive file details', 'read', 'Read a file’s name, type, parent folder IDs and modification time. This does not download file contents.', [fileField], async (credential, values) => {
    const body = await request('drive', `/files/${id(values, 'fileId')}?${new URLSearchParams({ fields: driveFields })}`, credential);
    return { summary: 'Read Drive file metadata.', items: [driveFile(body)] };
  }),
  {
    ...adapter('drive', 'download-file', 'Download Drive file', 'read', 'Download a regular Drive file such as a logo, image, PDF, or ZIP (up to 20 MiB). Returns base64 bytes and SHA-256. For large files, call the Workspace REST action from code and decode contentBase64 directly to disk without printing it into chat. Requires renewed Drive read permission for existing files.', [fileField], async (credential, values) => downloadDriveFile(credential, required(values, 'fileId'))),
    requiredScopes: [scope('drive.readonly')],
  },
  adapter('drive', 'create-folder', 'Create Drive folder', 'write', 'Create a folder, optionally inside another folder accessible to this app.', [titleField, field('parentId', 'Parent folder ID (optional)', false)], async (credential, values) => {
    const body = await request('drive', '/files?fields=id,name', credential, 'POST', { name: bounded(values, 'title', 200), mimeType: 'application/vnd.google-apps.folder', ...(values.parentId?.trim() ? { parents: [decodeURIComponent(id(values, 'parentId'))] } : {}) });
    return { summary: 'Created Drive folder.', items: [{ folderId: confirmed(body, 'id'), name: string(body.name) }] };
  }),
  adapter('drive', 'create-text-file', 'Create Drive text file', 'write', 'Upload a UTF-8 text file of up to 50,000 characters. Uses only the selected account’s app file permission.', [titleField, textField, field('parentId', 'Parent folder ID (optional)', false)], async (credential, values) => {
    const metadata = { name: bounded(values, 'title', 200), mimeType: 'text/plain', ...(values.parentId?.trim() ? { parents: [decodeURIComponent(id(values, 'parentId'))] } : {}) };
    const text = content(values, 'text', 50_000); const boundary = `connector_${randomUUID()}`;
    const body = await apiJson('Google Drive', 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', { method: 'POST', headers: { ...bearer(credential), 'content-type': `multipart/related; boundary=${boundary}` }, body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${text}\r\n--${boundary}--\r\n` });
    return { summary: 'Created Drive text file.', items: [{ fileId: confirmed(body, 'id'), name: string(body.name) }] };
  }),
  adapter('meet', 'create-meeting', 'Create meeting link', 'write', 'Create a Google Meet space and meeting link. This does not create a Calendar invitation or invite participants.', [], async (credential) => {
    const body = await request('meet', '/spaces', credential, 'POST', {});
    return { summary: 'Created a Google Meet meeting space.', items: [{ name: confirmed(body, 'name'), meetingUri: string(body.meetingUri), meetingCode: string(body.meetingCode) }] };
  }),
  adapter('meet', 'read-space', 'Read meeting space', 'read', 'Read a meeting space you can access. Enter its ID or meeting code without the spaces/ prefix.', [spaceField], async (credential, values) => {
    const body = await request('meet', `/spaces/${id(values, 'spaceId')}`, credential);
    return { summary: 'Read Google Meet space.', items: [{ name: string(body.name), meetingUri: string(body.meetingUri), meetingCode: string(body.meetingCode), activeConference: string(obj(body.activeConference).conferenceRecord) }] };
  }),
  adapter('meet', 'list-conferences', 'List conference records', 'read', 'List up to 25 accessible Meet conference records. Requires the relevant Workspace permissions.', [pageField], async (credential, values) => {
    const body = await request('meet', `/conferenceRecords?${query(values, { pageSize: '25' })}`, credential);
    return paged('Listed accessible Meet conference records.', records(body.conferenceRecords).map((row) => ({ name: string(row.name), space: string(row.space), startTime: string(row.startTime), endTime: string(row.endTime) })), body);
  }),
  adapter('chat', 'list-spaces', 'List Chat spaces', 'read', 'List up to 50 spaces for the selected user. Group chats and direct messages appear after the first message is sent.', [pageField], async (credential, values) => {
    const body = await request('chat', `/spaces?${query(values, { pageSize: '50' })}`, credential);
    return paged('Listed Google Chat spaces.', records(body.spaces).map((row) => ({ name: string(row.name), displayName: string(row.displayName), type: string(row.spaceType) })), body);
  }),
  adapter('chat', 'list-messages', 'Read Chat messages', 'read', 'Read up to 50 messages in a space available to the selected user. This does not list deleted messages or attachments.', [spaceField, pageField], async (credential, values) => {
    const body = await request('chat', `/spaces/${id(values, 'spaceId')}/messages?${query(values, { pageSize: '50', orderBy: 'createTime desc' })}`, credential);
    return paged('Read Google Chat messages.', records(body.messages).map((row) => ({ name: string(row.name), sender: string(obj(row.sender).name), text: typeof row.text === 'string' ? row.text.slice(0, 20_000) : '', createTime: string(row.createTime), thread: string(obj(row.thread).name) })), body);
  }),
  adapter('chat', 'send-message', 'Send Chat message', 'write', 'Send a plain-text message to a Google Chat space as the selected user.', [spaceField, textField], async (credential, values) => {
    const body = await request('chat', `/spaces/${id(values, 'spaceId')}/messages`, credential, 'POST', { text: content(values, 'text', 4000) });
    return { summary: 'Sent Google Chat message.', items: [{ name: confirmed(body, 'name'), createTime: string(body.createTime) }] };
  }),
  adapter('tasks', 'list-tasklists', 'List task lists', 'read', 'List up to 100 task lists in the selected account.', [pageField], async (credential, values) => {
    const body = await request('tasks', `/users/@me/lists?${query(values, { maxResults: '100' })}`, credential);
    return paged('Listed Google Tasks lists.', records(body.items).map((row) => ({ tasklistId: string(row.id), title: string(row.title), updated: string(row.updated) })), body);
  }),
  adapter('tasks', 'list-tasks', 'List tasks', 'read', 'List up to 100 incomplete or completed tasks, including hidden completed tasks, in a task list.', [tasklistField, pageField], async (credential, values) => {
    const body = await request('tasks', `/lists/${id(values, 'tasklistId')}/tasks?${query(values, { maxResults: '100', showCompleted: 'true', showHidden: 'true' })}`, credential);
    return paged('Listed Google Tasks.', records(body.items).map(task), body);
  }),
  adapter('tasks', 'create-task', 'Create task', 'write', 'Create a task with an optional note and due date (Google Tasks stores dates without a time of day).', [tasklistField, titleField, notesField, field('dueDate', 'Due date YYYY-MM-DD (optional)', false)], async (credential, values) => {
    const body = await request('tasks', `/lists/${id(values, 'tasklistId')}/tasks`, credential, 'POST', taskInput(values));
    return { summary: 'Created Google Task.', items: [{ ...task(body), taskId: confirmed(body, 'id') }] };
  }),
  adapter('tasks', 'update-task', 'Update task', 'write', 'Update a task title and optionally notes or due date. Omitted optional fields remain unchanged.', [tasklistField, field('taskId', 'Task ID'), titleField, notesField, field('dueDate', 'Due date YYYY-MM-DD (optional)', false)], async (credential, values) => {
    const body = await request('tasks', `/lists/${id(values, 'tasklistId')}/tasks/${id(values, 'taskId')}`, credential, 'PATCH', taskInput(values));
    return { summary: 'Updated Google Task.', items: [{ ...task(body), taskId: confirmed(body, 'id') }] };
  }),
  adapter('tasks', 'complete-task', 'Complete task', 'write', 'Mark a task complete in the selected account.', [tasklistField, field('taskId', 'Task ID')], async (credential, values) => {
    const body = await request('tasks', `/lists/${id(values, 'tasklistId')}/tasks/${id(values, 'taskId')}`, credential, 'PATCH', { status: 'completed' });
    if (body.status !== 'completed') throw new ProviderError('Google did not confirm that the task was completed.', 502);
    return { summary: 'Completed Google Task.', items: [{ taskId: confirmed(body, 'id'), status: 'completed' }] };
  }),
  adapter('voice', 'list-audit-events', 'Read Voice audit activity', 'read', 'Read up to 25 Google Voice activity events. Requires a Google Workspace administrator with Reports access and an eligible Voice subscription. No personal calls, texts, or voicemail access.', [field('userEmail', 'Workspace user email (optional; blank means all users)', false), pageField], async (credential, values) => {
    const user = bounded(values, 'userEmail', 254, true) || 'all';
    if (user !== 'all' && !/^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/.test(user)) throw new ProviderError('Use a Workspace user email or leave it blank for all users.');
    const body = await request('voice', `/activity/users/${encodeURIComponent(user)}/applications/voice?${query(values, { maxResults: '25' })}`, credential);
    return paged('Read Google Voice administrator audit activity.', records(body.items).map((row) => ({ time: string(obj(row.id).time), actor: string(obj(row.actor).email), events: records(row.events).map((event) => string(event.name)).join(', ') })), body);
  }),
  adapter('maps', 'search-places', 'Search Maps places', 'read', 'Search up to 20 public places with Places API (New). Uses the Cloud billing project key attached to the selected account; Google may charge for requests.', [field('query', 'Place search')], async (credential, values) => {
    const body = await placesRequest(credential, ':searchText', 'places.id,places.displayName,places.formattedAddress,places.location,places.googleMapsUri', { textQuery: bounded(values, 'query', 1000), pageSize: 20 });
    return { summary: 'Returned up to 20 public places.', items: records(body.places).map(place) };
  }),
  adapter('maps', 'read-place', 'Read Maps place details', 'read', 'Read public name, address, location, and Maps link for a place ID using Places API (New). Google may charge for requests.', [field('placeId', 'Place ID')], async (credential, values) => {
    const body = await placesRequest(credential, `/${id(values, 'placeId')}`, 'id,displayName,formattedAddress,location,googleMapsUri');
    return { summary: 'Read public place details.', items: [place(body)] };
  }),
];

function driveFile(row: Record<string, unknown>) {
  return { fileId: string(row.id), name: string(row.name), mimeType: string(row.mimeType), modifiedTime: string(row.modifiedTime), webViewLink: string(row.webViewLink), parents: Array.isArray(row.parents) ? row.parents.slice(0, 10).map((parent) => string(parent)).join(', ') : '' };
}
function task(row: Record<string, unknown>) { return { taskId: string(row.id), title: string(row.title), notes: string(row.notes), due: string(row.due), status: string(row.status), completed: string(row.completed) }; }
function taskInput(values: ActionValues) {
  const dueDate = bounded(values, 'dueDate', 10, true);
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(`${dueDate}T00:00:00Z`)) || new Date(`${dueDate}T00:00:00Z`).toISOString().slice(0, 10) !== dueDate)) throw new ProviderError('dueDate must be a valid date in YYYY-MM-DD format.');
  return { title: bounded(values, 'title', 1024), ...(values.notes ? { notes: content(values, 'notes', 8192, true) } : {}), ...(dueDate ? { due: `${dueDate}T00:00:00Z` } : {}) };
}
function place(row: Record<string, unknown>) {
  const location = obj(row.location);
  return { placeId: string(row.id), name: string(obj(row.displayName).text), address: string(row.formattedAddress), latitude: typeof location.latitude === 'number' ? location.latitude : null, longitude: typeof location.longitude === 'number' ? location.longitude : null, googleMapsUri: string(row.googleMapsUri) };
}
async function placesRequest(credential: Credential, suffix: string, fieldMask: string, body?: unknown) {
  const key = credential.fields?.mapsApiKey?.trim();
  if (!key || key.length > 512 || /[\r\n\0]/.test(key)) throw new ProviderError('Add a Google Cloud project API key with Places API (New) enabled to this account before using Maps.');
  const result = await apiJson('Google Maps Places', `https://places.googleapis.com/v1/places${suffix}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fieldMask, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (result.error !== undefined) throw new ProviderError('Google Maps could not complete this request. Check the project API configuration and billing.', 502);
  return result;
}

export function getWorkspaceAction(app: string, actionId: string): ActionAdapter | undefined { return workspaceActions.find((entry) => entry.provider === app && entry.definition.id === actionId); }
export function listWorkspaceActions(app: string): ActionDefinition[] { return workspaceActions.filter((entry) => entry.provider === app).map((entry) => entry.definition); }
