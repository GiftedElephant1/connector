import type { ActionAdapter, ActionField, ActionResult, ActionValues } from './action-types';
import { bearer } from './action-http';
import { isObject } from './provider-http';
import { ProviderError, type Credential } from './provider-types';

const scope = (name: string) => `https://www.googleapis.com/auth/${name}`;
const MAX_BODY_BYTES = 500_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_QUERY_BYTES = 10_000;

type Api = {
  id: string;
  name: string;
  base: string;
  reference: string;
  readScopes: string[];
  writeScopes: string[];
  readExample: string;
  writeExample: string;
  features: string;
};

/** Every destination is a fixed official API. These are user OAuth APIs, not domain-wide impersonation. */
const apis: Api[] = [
  { id: 'sheets', name: 'Google Sheets', base: 'https://sheets.googleapis.com/v4', reference: 'https://developers.google.com/workspace/sheets/api/reference/rest', readScopes: [scope('spreadsheets')], writeScopes: [scope('spreadsheets')], readExample: '/spreadsheets/SPREADSHEET_ID', writeExample: 'POST /spreadsheets/SPREADSHEET_ID:batchUpdate with {"requests":[{"updateSheetProperties":{"properties":{"sheetId":0,"title":"Summary"},"fields":"title"}}]}', features: 'Read spreadsheet metadata and grid data; use spreadsheets.batchUpdate for tabs, formatting, charts, pivot tables, validation, filters, named ranges, and other supported requests. For values writes, set query {"valueInputOption":"USER_ENTERED"} to evaluate formulas or RAW to store literal values.' },
  { id: 'docs', name: 'Google Docs', base: 'https://docs.googleapis.com/v1', reference: 'https://developers.google.com/workspace/docs/api/reference/rest', readScopes: [scope('documents')], writeScopes: [scope('documents')], readExample: '/documents/DOCUMENT_ID with query {"includeTabsContent":true}', writeExample: 'POST /documents/DOCUMENT_ID:batchUpdate with {"requests":[{"updateTextStyle":{"range":{"startIndex":1,"endIndex":6},"textStyle":{"bold":true},"fields":"bold"}}]}', features: 'Read the complete document structure, including tables and tabs; use documents.batchUpdate for text, formatting, tables, images, headers, footers, links, and other supported requests. Use includeTabsContent=true when reading document tabs.' },
  { id: 'slides', name: 'Google Slides', base: 'https://slides.googleapis.com/v1', reference: 'https://developers.google.com/workspace/slides/api/reference/rest', readScopes: [scope('presentations')], writeScopes: [scope('presentations')], readExample: '/presentations/PRESENTATION_ID', writeExample: 'POST /presentations/PRESENTATION_ID:batchUpdate with {"requests":[{"createSlide":{"slideLayoutReference":{"predefinedLayout":"BLANK"}}}]}', features: 'Read complete presentation and page structures; use presentations.batchUpdate for slides, text, formatting, shapes, tables, images, charts, positioning, and other supported requests.' },
  { id: 'gmail', name: 'Gmail', base: 'https://gmail.googleapis.com/gmail/v1/users/me', reference: 'https://developers.google.com/workspace/gmail/api/reference/rest', readScopes: [scope('gmail.readonly')], writeScopes: ['https://mail.google.com/', scope('gmail.settings.basic')], readExample: '/messages/MESSAGE_ID with query {"format":"full"}', writeExample: 'POST /messages/MESSAGE_ID/modify with {"addLabelIds":["STARRED"]}', features: 'Read messages, threads, attachments, labels, history, and supported settings; send MIME messages and attachments using base64url raw fields, manage drafts and labels, archive, trash, and delete mail. Sensitive settings requiring service-account domain-wide delegation are not supported by this user OAuth connection. Paths are always relative to users/me for the selected account.' },
  { id: 'drive', name: 'Google Drive', base: 'https://www.googleapis.com/drive/v3', reference: 'https://developers.google.com/workspace/drive/api/reference/rest/v3', readScopes: [scope('drive.metadata.readonly')], writeScopes: [scope('drive')], readExample: '/files/FILE_ID with query {"fields":"id,name,mimeType,capabilities,permissions","supportsAllDrives":true}', writeExample: 'PATCH /files/FILE_ID with {"name":"Renamed workbook.xlsx"}', features: 'Read file metadata, changes, shared drives, permissions, comments, and revisions; manage files, folders, sharing, comments, trash, copies, and shared drives where Google permits the selected user. Use the dedicated upload/download/export actions for binary file content; this action accepts and returns JSON only.' },
  { id: 'meet', name: 'Google Meet', base: 'https://meet.googleapis.com/v2', reference: 'https://developers.google.com/workspace/meet/api/reference/rest', readScopes: [scope('meetings.space.readonly')], writeScopes: [scope('meetings.space.created'), scope('meetings.space.settings')], readExample: '/conferenceRecords/CONFERENCE_ID/participants', writeExample: 'PATCH /spaces/SPACE_ID with query {"updateMask":"config.accessType"} and {"config":{"accessType":"TRUSTED"}}', features: 'Read spaces, conference records, participants, recordings, and transcript metadata or entries; create spaces, change permitted settings, or end an active conference. Requires the appropriate Meet subscription and account role; downloading recording files uses Drive. This does not join calls or create Calendar invitations.' },
  { id: 'chat', name: 'Google Chat', base: 'https://chat.googleapis.com/v1', reference: 'https://developers.google.com/workspace/chat/api/reference/rest', readScopes: [scope('chat.spaces.readonly'), scope('chat.messages.readonly')], writeScopes: ['chat.spaces', 'chat.messages', 'chat.memberships', 'chat.delete', 'chat.users.readstate', 'chat.users.spacesettings', 'chat.spaces.pins', 'chat.customemojis', 'chat.users.availability', 'chat.users.sections'].map(scope), readExample: '/spaces/SPACE_ID/messages with query {"pageSize":25}', writeExample: 'PATCH /spaces/SPACE_ID/messages/MESSAGE_ID with query {"updateMask":"text"} and {"text":"Updated message"}', features: 'Read or manage supported spaces, messages, memberships, reactions, pins, custom emoji, read states, and user settings using user authentication. App-only, admin-only, import-mode, and binary upload APIs are not supplied by this user OAuth connection. Some methods require an eligible account, configured Chat app, extra scopes, or ownership of the message.' },
  { id: 'tasks', name: 'Google Tasks', base: 'https://tasks.googleapis.com/tasks/v1', reference: 'https://developers.google.com/workspace/tasks/reference/rest', readScopes: [scope('tasks')], writeScopes: [scope('tasks')], readExample: '/users/@me/lists', writeExample: 'POST /lists/TASKLIST_ID/tasks/TASK_ID/move with query {"parent":"PARENT_TASK_ID"}', features: 'Read, create, rename, and delete task lists; create, edit, complete, move, nest, and delete tasks, and clear completed tasks. Google Tasks due dates do not preserve a time of day.' },
];

function invalid(message: string): never { throw new ProviderError(message); }

function jsonObject(value: string | undefined, label: string, byteLimit: number): Record<string, unknown> {
  const input = value?.trim() || '{}';
  if (Buffer.byteLength(input) > byteLimit) invalid(`${label} exceeds ${byteLimit.toLocaleString('en-US')} UTF-8 bytes. Split the request into smaller operations.`);
  let parsed: unknown;
  try { parsed = JSON.parse(input); } catch { invalid(`${label} must be a valid JSON object.`); }
  if (!isObject(parsed)) invalid(`${label} must be a JSON object, not an array, string, or null.`);
  // Bound nesting and cardinality before JSON serialization; reject numbers JSON.parse overflowed.
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  let visited = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++visited > 50_000 || next.depth > 50) invalid(`${label} is too deeply nested or contains too many entries. Split the request.`);
    if (typeof next.value === 'number' && !Number.isFinite(next.value)) invalid(`${label} must contain only finite JSON numbers.`);
    if (next.value !== null && typeof next.value === 'object') {
      for (const item of Object.values(next.value)) pending.push({ value: item, depth: next.depth + 1 });
    }
  }
  return parsed;
}

function safePath(value: string | undefined): string {
  const path = value?.trim() ?? '';
  if (!path || path.length > 8192 || !path.startsWith('/') || path.startsWith('//') || /[\\?#\u0000-\u0020\u007f]/.test(path)) {
    invalid('path must be a relative API path beginning with one /, without a host, query, fragment, backslash, or unescaped whitespace. Put query parameters in queryJson.');
  }
  for (const segment of path.split('/').slice(1)) {
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { invalid('path contains invalid percent encoding.'); }
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/%?#\u0000-\u001f\u007f]/.test(decoded)) {
      invalid('path cannot contain empty or traversal segments, encoded slashes, double encoding, query delimiters, or control characters.');
    }
  }
  return path;
}

function queryParameters(input: Record<string, unknown>): URLSearchParams {
  const result = new URLSearchParams();
  const entries = Object.entries(input);
  if (entries.length > 100) invalid('queryJson must contain at most 100 parameters.');
  const forbidden = new Set(['accesstoken', 'oauthtoken', 'authorization', 'key', 'apikey', 'xgoogapikey', 'clientid', 'clientsecret', 'refreshtoken', 'callback', 'jsonp', 'method', 'httpmethod', 'xhttpmethod', 'xhttpmethodoverride', 'xmethodoverride', 'uploadtype', 'uploadprotocol']);
  for (const [key, raw] of entries) {
    if (!/^[A-Za-z_$][A-Za-z0-9_.$-]{0,99}$/.test(key) || forbidden.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) invalid('queryJson contains an unsupported parameter. Authentication, method overrides, JSONP, and upload controls cannot be supplied.');
    const values = Array.isArray(raw) ? raw : [raw];
    if (!values.length || values.length > 100) invalid('Each query parameter must have 1–100 scalar values.');
    for (const value of values) {
      if (!['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value)) invalid('Query parameters must be strings, finite numbers, booleans, or arrays of these values.');
      const text = String(value);
      if (/[\u0000-\u001f\u007f]/.test(text)) invalid('Query values cannot contain control characters.');
      if (key.toLowerCase() === 'alt' && text !== 'json') invalid('Only JSON responses are supported. Use a dedicated download or export action for file content.');
      result.append(key, text);
    }
  }
  return result;
}

async function responseBody(response: Response, api: Api, write: boolean): Promise<string> {
  const sizeError = () => new ProviderError(`${api.name} returned more than 1 MiB of JSON. Nothing was truncated. Use fields, a smaller range, or pageSize/maxResults, then follow page tokens. ${write ? 'The operation may have succeeded; check Google before retrying.' : 'Narrow the read and try again.'}`, write ? 502 : 413);
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw sizeError();
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw sizeError();
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(`${api.name} did not finish returning its response. ${write ? 'The operation may have succeeded; check Google before retrying.' : 'Try the read again.'}`, 502);
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function execute(api: Api, write: boolean, credential: Credential, values: ActionValues): Promise<ActionResult> {
  const method = write ? values.method?.trim().toUpperCase() || 'POST' : 'GET';
  if (write && !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) invalid('write-api requires POST, PUT, PATCH, or DELETE. Use read-api for GET.');
  if (!write && (values.method && values.method !== 'GET' || values.bodyJson?.trim())) invalid('read-api only permits GET without a request body. Use the confirmed write-api action for changes.');
  if (values.headers || values.authorization || values.url) invalid('Custom URLs, authentication, and headers are not supported. Use path and queryJson.');
  const path = safePath(values.path);
  const url = new URL(api.base + path);
  const base = new URL(api.base);
  if (url.origin !== base.origin || !url.pathname.startsWith(`${base.pathname}/`)) invalid('The path must stay within this app’s official API.');
  url.search = queryParameters(jsonObject(values.queryJson, 'queryJson', MAX_QUERY_BYTES)).toString();
  if (url.href.length > 24_000) invalid('The encoded API URL is too long. Shorten the path or query.');
  const body = write && values.bodyJson?.trim() ? JSON.stringify(jsonObject(values.bodyJson, 'bodyJson', MAX_BODY_BYTES)) : undefined;
  const headers = { ...bearer(credential), accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) };
  let response: Response;
  try {
    response = await fetch(url.toString(), { method, headers, ...(body === undefined ? {} : { body }), redirect: 'error', signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new ProviderError(`${api.name} did not return a response. ${write ? 'The operation may have succeeded; check Google before retrying.' : 'Check connectivity and try again.'}`, 502);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401) throw new ProviderError(`${api.name} rejected the account credential. Reconnect the selected Google account.`, 401);
    if (response.status === 403) throw new ProviderError(`${api.name} denied this API operation. Update the selected account’s permissions in Google Workspace, and check its file access, Google API configuration, account role, and subscription. Some API methods require app authentication or administrator delegation that this user connection does not provide.`, 403);
    if (response.status === 429) throw new ProviderError(`${api.name} is rate limiting requests. Check Google before retrying a write.`, 429);
    const status = [400, 404, 409, 422].includes(response.status) ? response.status : 502;
    throw new ProviderError(`${api.name} rejected or could not complete the API request (HTTP ${response.status}). Check the path, method, query, and JSON body against ${api.reference}.${write ? ' Check Google before retrying a write.' : ''}`, status);
  }
  const text = response.status === 204 ? '' : await responseBody(response, api, write);
  let data: unknown = null;
  if (text.trim()) {
    try { data = JSON.parse(text); } catch {
      throw new ProviderError(`${api.name} returned a non-JSON response. Use a dedicated download/export action for file content.${write ? ' Check Google before retrying; the operation may have succeeded.' : ''}`, 502);
    }
  }
  if (isObject(data) && data.error !== undefined) throw new ProviderError(`${api.name} reported an API error. Check Google before retrying a write.`, 502);
  const nextPageToken = isObject(data) && typeof data.nextPageToken === 'string' ? data.nextPageToken : '';
  return {
    summary: `${api.name} ${method} completed (HTTP ${response.status}). ${text.trim() ? 'The complete JSON response is in responseJson.' : 'The response has no content.'}${nextPageToken ? ' More results are available; call read-api with queryJson.pageToken from the response.' : ''}`,
    items: [{ status: response.status, method, responseJson: JSON.stringify(data), truncated: false }],
  };
}

function createAdapter(api: Api, write: boolean): ActionAdapter {
  const path: ActionField = { name: 'path', label: 'Relative API path', type: 'text', required: true, help: `Base: ${api.base}. Do not include the base, ?query, or #fragment. URL-encode individual path segments. Example: ${api.readExample}.` };
  const query: ActionField = { name: 'queryJson', label: 'Query parameters as JSON (optional)', type: 'textarea', help: 'JSON object of strings, numbers, booleans, or arrays of these values (arrays become repeated parameters). Example: {"fields":"*"}. Use pageToken, pageSize/maxResults, fields, and ranges to keep responses below 1 MiB. Maximum 10,000 UTF-8 bytes.', maxLength: MAX_QUERY_BYTES };
  const fields: ActionField[] = write ? [
    { name: 'method', label: 'HTTP method', type: 'select', required: true, default: 'POST', options: ['POST', 'PUT', 'PATCH', 'DELETE'].map(value => ({ value, label: value })) },
    path, query,
    { name: 'bodyJson', label: 'Request body as JSON (optional)', type: 'textarea', preserveWhitespace: true, maxLength: MAX_BODY_BYTES, help: `A JSON object up to 500,000 UTF-8 bytes. Leave blank when the endpoint accepts no body. Example: ${api.writeExample}. Nested batchUpdate request objects are supported.` },
  ] : [path, query];
  return {
    provider: api.id,
    requiredScopes: write ? api.writeScopes : api.readScopes,
    definition: {
      id: write ? 'write-api' : 'read-api', label: `${write ? 'Change' : 'Read'} ${api.name} through its API`, kind: write ? 'write' : 'read', group: ['gmail', 'chat'].includes(api.id) ? 'inbox' : 'publishing', fields,
      description: `${write ? 'Advanced confirmed write using POST, PUT, PATCH, or DELETE. Changes, sharing, sending, and deletion require explicit confirmation and a unique requestId in the Workspace pipeline.' : 'Advanced read using GET only. Returns complete JSON, including nested structures, instead of a simplified preview.'} ${api.features} Endpoint permissions are enforced by Google; update account permissions for newly enabled features. JSON responses are limited to 1 MiB and are never silently truncated. Reference: ${api.reference}`,
    },
    execute: (credential, values) => execute(api, write, credential, values),
  };
}

export const workspaceApiActions: ActionAdapter[] = apis.flatMap(api => [createAdapter(api, false), createAdapter(api, true)]);
