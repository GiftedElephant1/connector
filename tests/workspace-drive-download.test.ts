import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { getWorkspaceAction } from '../server/workspace-actions';
import { MAX_DRIVE_DOWNLOAD_BYTES, downloadDriveFile } from '../server/workspace-drive-download';
import { ProviderError } from '../server/provider-types';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'private-workspace-download-token' };
const fileId = 'brand_logo-123';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 255, 128, 1, 254]);
const digest = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
const details = (changes: Record<string, unknown> = {}) => ({ id: fileId, name: 'Vectre Pay logo.png', mimeType: 'image/png', size: String(png.length), capabilities: { canDownload: true }, ...changes });

function mock(responses: Response[], inspect: (url: URL, init?: RequestInit) => void = () => {}) {
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.pathname, `/drive/v3/files/${fileId}`);
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(url.toString().includes(credential.accessToken), false);
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${credential.accessToken}`);
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, 'GET');
    assert.ok(init?.signal);
    inspect(url, init);
    const response = responses[calls++];
    assert.ok(response, 'No unexpected extra request');
    return response;
  };
  return () => calls;
}

function rejected(status: number, message: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof ProviderError);
    assert.equal(error.status, status);
    assert.match(error.message, message);
    assert.equal(error.message.includes(credential.accessToken), false);
    return true;
  };
}

test('Drive action downloads exact binary logo bytes with file metadata and checksum', async () => {
  const action = getWorkspaceAction('drive', 'download-file');
  assert.ok(action);
  assert.equal(action.definition.kind, 'read');
  assert.deepEqual(action.requiredScopes, ['https://www.googleapis.com/auth/drive.readonly']);
  assert.deepEqual(action.definition.fields.map(field => field.name), ['fileId']);
  const calls = mock([
    Response.json(details({ sha256Checksum: digest(png), webContentLink: 'https://untrusted.example/download', privateDebug: credential.accessToken })),
    new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } }),
  ], (url) => {
    if (url.searchParams.has('fields')) {
      assert.equal(url.searchParams.get('fields'), 'id,name,mimeType,size,capabilities(canDownload),sha256Checksum');
      assert.equal(url.searchParams.has('alt'), false);
    } else assert.equal(url.searchParams.get('alt'), 'media');
  });
  const result = await action.execute(credential, { fileId }, {});
  assert.equal(calls(), 2);
  assert.deepEqual(result.items?.[0], { fileId, name: 'Vectre Pay logo.png', mimeType: 'image/png', size: png.length, encoding: 'base64', contentBase64: png.toString('base64'), sha256: digest(png) });
  assert.deepEqual(Buffer.from(String(result.items?.[0].contentBase64), 'base64'), png);
  assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
  assert.equal(JSON.stringify(result).includes('untrusted.example'), false);
});

test('Drive SVG bytes remain unchanged, including whitespace and Unicode', async () => {
  const svg = Buffer.from('\n<svg xmlns="http://www.w3.org/2000/svg"><title>Vectre ✓</title>\n  <path d="M1 2" />\n</svg>\n');
  mock([Response.json(details({ name: 'Vectre logo.svg', mimeType: 'image/svg+xml', size: String(svg.length) })), new Response(svg)]);
  const result = await downloadDriveFile(credential, fileId);
  assert.deepEqual(Buffer.from(String(result.items?.[0].contentBase64), 'base64'), svg);
  assert.equal(result.items?.[0].mimeType, 'image/svg+xml');
});

test('Drive file IDs cannot become URLs, paths, query strings, or request headers', async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
  for (const invalid of ['', '../file', 'https://example.com', 'id?alt=media', 'id\r\nsecret', 'a'.repeat(251)]) {
    await assert.rejects(downloadDriveFile(credential, invalid), rejected(400, /file ID/));
  }
});

test('Drive metadata must describe the requested file with a valid name, MIME type, and size', async () => {
  for (const metadata of [[], null, details({ id: 'another-file' }), details({ name: '' }), details({ name: 'file\nname' }), details({ mimeType: 'image/png\n' }), details({ size: '-1' }), details({ size: 'not-a-number' }), details({ size: '9007199254740992' })]) {
    const calls = mock([Response.json(metadata)]);
    await assert.rejects(downloadDriveFile(credential, fileId), rejected(502, /invalid file/));
    assert.equal(calls(), 1);
  }
  mock([new Response('not json')]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(502, /unreadable file details/));
});

test('Drive folders, shortcuts, and Google-native files receive actionable errors without a media request', async () => {
  for (const [mimeType, message] of [
    ['application/vnd.google-apps.folder', /folder/],
    ['application/vnd.google-apps.shortcut', /original file ID/],
    ['application/vnd.google-apps.document', /Docs, Sheets, or Slides/],
    ['application/vnd.google-apps.spreadsheet', /export/],
  ] as const) {
    const calls = mock([Response.json(details({ mimeType }))]);
    await assert.rejects(downloadDriveFile(credential, fileId), rejected(400, message));
    assert.equal(calls(), 1);
  }
});

test('Drive respects owner download restrictions before requesting content', async () => {
  const calls = mock([Response.json(details({ capabilities: { canDownload: false } }))]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(403, /disabled downloading/));
  assert.equal(calls(), 1);
});

test('Drive rejects oversized files from metadata before downloading them', async () => {
  const calls = mock([Response.json(details({ size: String(MAX_DRIVE_DOWNLOAD_BYTES + 1) }))]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(413, /20 MiB/));
  assert.equal(calls(), 1);
});

test('Drive cancels oversized binary responses declared by Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  mock([Response.json(details()), new Response(stream, { headers: { 'content-length': String(MAX_DRIVE_DOWNLOAD_BYTES + 1) } })]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(413, /20 MiB/));
  assert.equal(cancelled, true);
});

test('Drive cancels a streaming download at its byte limit even without Content-Length', async () => {
  let cancelled = false;
  let chunksRead = 0;
  const chunk = new Uint8Array(1024 * 1024);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { chunksRead++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  mock([Response.json(details({ size: undefined })), new Response(stream)]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(413, /20 MiB/));
  assert.equal(chunksRead, 21);
  assert.equal(cancelled, true);
});

test('Drive bounds metadata streams without Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(65 * 1024)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const calls = mock([new Response(stream)]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(413, /oversized file details/));
  assert.equal(cancelled, true);
  assert.equal(calls(), 1);
});

test('Drive remote errors are bounded, cancel unread error bodies, and never expose payloads', async () => {
  for (const stage of ['metadata', 'media']) {
    for (const [status, expectedStatus, message] of [[401, 401, /authorization expired/], [403, 403, /denied this download/], [404, 404, /could not find this file/], [429, 429, /rate limiting/], [500, 502, /complete file response/], [302, 502, /complete file response/], [206, 502, /complete file response/]] as const) {
      let cancelled = false;
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(Buffer.from(credential.accessToken.repeat(1000))); },
        cancel() { cancelled = true; },
      }, { highWaterMark: 0 }), { status });
      mock(stage === 'media' ? [Response.json(details()), response] : [response]);
      await assert.rejects(downloadDriveFile(credential, fileId), rejected(expectedStatus, message));
      assert.equal(cancelled, true);
    }
  }
});

test('Drive refuses redirects and network failures without leaking the original error', async () => {
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    throw new Error(`redirect/network failure containing ${credential.accessToken}`);
  };
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(502, /could not be reached/));
  const response = Response.json(details());
  Object.defineProperty(response, 'redirected', { value: true });
  mock([response]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(502, /complete file response/));
});

test('Drive refuses incomplete, changed, or corrupted files rather than returning successful bytes', async () => {
  mock([Response.json(details()), new Response(png.subarray(0, 5))]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(502, /changed or its download was incomplete/));
  mock([Response.json(details({ sha256Checksum: 'f'.repeat(64) })), new Response(png)]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(502, /changed or its download was incomplete/));
  mock([Response.json(details()), new Response(new ReadableStream({ start(controller) { controller.error(new Error(credential.accessToken)); } }))]);
  await assert.rejects(downloadDriveFile(credential, fileId), rejected(502, /did not finish returning/));
});

test('Drive supports empty regular files and a response without metadata size', async () => {
  mock([Response.json(details({ size: '0' })), new Response(null)]);
  let result = await downloadDriveFile(credential, fileId);
  assert.equal(result.items?.[0].size, 0);
  assert.equal(result.items?.[0].contentBase64, '');
  mock([Response.json(details({ size: undefined })), new Response(png)]);
  result = await downloadDriveFile(credential, fileId);
  assert.equal(result.items?.[0].size, png.length);
});
