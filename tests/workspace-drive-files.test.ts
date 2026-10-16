import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { ProviderError } from '../server/provider-types';
import { exportDriveFile, MAX_DRIVE_EXPORT_BYTES, MAX_DRIVE_UPLOAD_BASE64_CHARS, MAX_DRIVE_UPLOAD_BYTES, updateDriveFileContent, uploadDriveFile, workspaceDriveFileActions } from '../server/workspace-drive-files';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const credential = { accessToken: 'private-drive-file-token' };
const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const sheetMime = 'application/vnd.google-apps.spreadsheet';
const payload = Buffer.from([80, 75, 3, 4, 0, 255, 128, 13, 10, 26, 0, 254]);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const upload = (changes: Record<string, string> = {}) => ({ name: 'Quarterly report.xlsx', mimeType: xlsx, contentBase64: payload.toString('base64'), ...changes });
const metadata = (changes: Record<string, unknown> = {}) => ({ id: 'file-123', name: 'Quarterly report.xlsx', mimeType: xlsx, size: String(payload.length), sha256Checksum: digest(payload), ...changes });
const googleMetadata = (changes: Record<string, unknown> = {}) => metadata({ mimeType: sheetMime, name: 'Quarterly report', sha256Checksum: undefined, size: undefined, capabilities: { canDownload: true }, ...changes });

function mock(responses: Response[], inspect: (url: URL, init: RequestInit, index: number) => void = () => {}) {
  let calls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(url.toString().includes(credential.accessToken), false);
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${credential.accessToken}`);
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    inspect(url, init, calls);
    const response = responses[calls++];
    assert.ok(response, 'No extra network requests');
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

test('Drive binary upload preserves exact bytes and sends metadata, folder and credentials to the official upload endpoint', async () => {
  const calls = mock([Response.json(metadata())], (url, init) => {
    assert.equal(url.pathname, '/upload/drive/v3/files');
    assert.equal(url.searchParams.get('uploadType'), 'multipart');
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(init.method, 'POST');
    const type = new Headers(init.headers).get('content-type')!;
    const boundary = type.match(/^multipart\/related; boundary=(connector_[\w-]+)$/)?.[1];
    assert.ok(boundary);
    assert.ok(Buffer.isBuffer(init.body));
    const body = init.body as Buffer;
    const delimiter = Buffer.from(`\r\n--${boundary}\r\n`);
    const split = body.indexOf(delimiter);
    assert.ok(split > 0);
    const json = body.subarray(body.indexOf('\r\n\r\n') + 4, split).toString('utf8');
    assert.deepEqual(JSON.parse(json), { name: 'Quarterly report.xlsx', mimeType: xlsx, parents: ['folder-123'] });
    const bytesStart = body.indexOf('\r\n\r\n', split + delimiter.length) + 4;
    const bytesEnd = body.length - Buffer.byteLength(`\r\n--${boundary}--\r\n`);
    assert.deepEqual(body.subarray(bytesStart, bytesEnd), payload);
  });
  const result = await uploadDriveFile(credential, upload({ parentId: 'folder-123' }));
  assert.equal(calls(), 1);
  assert.deepEqual(result.items?.[0], { fileId: 'file-123', name: 'Quarterly report.xlsx', mimeType: xlsx, uploadedBytes: payload.length, uploadedSha256: digest(payload), converted: false, checksumVerified: true, size: payload.length });
  assert.equal(result.link, 'https://drive.google.com/file/d/file-123/view');
  assert.equal(JSON.stringify(result).includes(credential.accessToken), false);
  assert.equal(JSON.stringify(result).includes(payload.toString('base64')), false);
});

test('Drive Excel conversion distinguishes uploaded MIME from Google Sheets metadata and warns about conversion fidelity', async () => {
  mock([Response.json(googleMetadata())], (_url, init) => {
    const body = (init.body as Buffer).toString('latin1');
    assert.ok(body.includes(`"mimeType":"${sheetMime}"`));
    assert.ok(body.includes(`Content-Type: ${xlsx}\r\n`));
  });
  const result = await uploadDriveFile(credential, upload({ convertTo: 'google-sheets' }));
  assert.equal(result.items?.[0].converted, true);
  assert.equal(result.items?.[0].checksumVerified, false);
  assert.equal(result.items?.[0].mimeType, sheetMime);
  assert.match(result.summary, /Excel-only features may not convert exactly/);
  assert.equal(result.link, 'https://docs.google.com/spreadsheets/d/file-123/edit');
});

test('Drive rejects malformed base64, noncanonical padding, input URLs and invalid metadata before network access', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected network access'); };
  for (const contentBase64 of ['', 'a', 'YQ', 'YQ=\n', 'YQ===', 'YR==', 'YQ==YQ==', 'YQ-=', 'YQ_=', 'data:application/octet-stream;base64,YQ==', 'https://example.com/file']) {
    await assert.rejects(uploadDriveFile(credential, upload({ contentBase64 })), rejected(400, /base64/i));
  }
  const invalidMetadata: Record<string, string>[] = [{ name: 'file\n.xlsx' }, { name: 'a'.repeat(251) }, { mimeType: 'text/plain\r\nX: injected' }, { mimeType: 'application/vnd.google-apps.spreadsheet' }, { parentId: 'https://example.com' }, { parentId: '../file' }, { convertTo: 'invalid' }, { mimeType: 'image/png', convertTo: 'google-sheets' }];
  for (const invalid of invalidMetadata) {
    await assert.rejects(uploadDriveFile(credential, upload(invalid)), (error: unknown) => error instanceof ProviderError && error.status === 400);
  }
  assert.equal(calls, 0);
});

test('Drive upload supports binary data above legacy textarea limits and enforces decoded 20 MiB limit', async () => {
  const bytes = Buffer.alloc(100_000, 255);
  mock([Response.json(metadata({ size: String(bytes.length), sha256Checksum: digest(bytes) }))]);
  const result = await uploadDriveFile(credential, upload({ contentBase64: bytes.toString('base64') }));
  assert.equal(result.items?.[0].uploadedBytes, bytes.length);
  const action = workspaceDriveFileActions.find(entry => entry.definition.id === 'upload-file')!;
  const field = action.definition.fields.find(entry => entry.name === 'contentBase64')!;
  assert.equal(field.maxLength, MAX_DRIVE_UPLOAD_BASE64_CHARS);
  assert.equal(field.preserveWhitespace, true);
  globalThis.fetch = async () => { throw new Error('Unexpected network access'); };
  await assert.rejects(uploadDriveFile(credential, upload({ contentBase64: 'A'.repeat(MAX_DRIVE_UPLOAD_BASE64_CHARS + 4) })), rejected(413, /20 MiB/));
  // 20 MiB + 1 has the same base64 encoded length as 20 MiB. Check the decoded limit too.
  const tooLarge = Buffer.alloc(MAX_DRIVE_UPLOAD_BYTES + 1).toString('base64');
  assert.equal(tooLarge.length, MAX_DRIVE_UPLOAD_BASE64_CHARS);
  await assert.rejects(uploadDriveFile(credential, upload({ contentBase64: tooLarge })), rejected(413, /20 MiB/));
});

test('Drive does not claim verified upload bytes when Google returns a conflicting checksum, size, or file type', async () => {
  for (const changes of [{ size: '1' }, { sha256Checksum: 'a'.repeat(64) }, { mimeType: sheetMime }]) {
    mock([Response.json(metadata(changes))]);
    await assert.rejects(uploadDriveFile(credential, upload()), rejected(502, /Check the file before retrying/));
  }
});

test('Drive uploads above 5 MB use a Google resumable session and send exact bytes in one bounded PUT', async () => {
  const bytes = Buffer.alloc(5_000_001, 128);
  const location = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=private-upload-session';
  const calls = mock([new Response(null, { headers: { location } }), Response.json(metadata({ size: String(bytes.length), sha256Checksum: digest(bytes) }))], (url, init, index) => {
    if (index === 0) {
      assert.equal(url.searchParams.get('uploadType'), 'resumable');
      assert.equal(init.method, 'POST');
      assert.equal(new Headers(init.headers).get('x-upload-content-length'), String(bytes.length));
      assert.equal(new Headers(init.headers).get('x-upload-content-type'), xlsx);
      assert.deepEqual(JSON.parse(String(init.body)), { name: 'Quarterly report.xlsx', mimeType: xlsx, parents: ['folder-123'] });
    } else {
      assert.equal(url.toString(), location);
      assert.equal(init.method, 'PUT');
      assert.equal(new Headers(init.headers).get('content-range'), `bytes 0-${bytes.length - 1}/${bytes.length}`);
      assert.deepEqual(init.body, bytes);
    }
  });
  const result = await uploadDriveFile(credential, upload({ contentBase64: bytes.toString('base64'), parentId: 'folder-123' }));
  assert.equal(calls(), 2);
  assert.equal(result.items?.[0].uploadedBytes, bytes.length);
  assert.equal(JSON.stringify(result).includes('private-upload-session'), false);
});

test('Drive never sends bytes or credentials to an untrusted resumable Location', async () => {
  const contentBase64 = Buffer.alloc(5_000_001).toString('base64');
  for (const location of [
    '', 'not a URL',
    'https://evil.example/upload/drive/v3/files?uploadType=resumable&upload_id=secret',
    'https://www.googleapis.com.evil.example/upload/drive/v3/files?uploadType=resumable&upload_id=secret',
    'http://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=secret',
    'https://www.googleapis.com:8443/upload/drive/v3/files?uploadType=resumable&upload_id=secret',
    'https://user:pass@www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=secret',
    'https://www.googleapis.com/another/path?uploadType=resumable&upload_id=secret',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=secret#fragment',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&upload_id=secret',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable',
  ]) {
    const calls = mock([new Response(null, { headers: { location } })]);
    await assert.rejects(uploadDriveFile(credential, upload({ contentBase64 })), rejected(502, /upload session/));
    assert.equal(calls(), 1);
  }
});

test('Drive content replacements above 5 MB start a resumable PATCH, then require completed upload confirmation', async () => {
  const bytes = Buffer.alloc(5_000_001, 64);
  const location = 'https://www.googleapis.com/upload/drive/v3/files/file-123?uploadType=resumable&upload_id=private-session';
  const calls = mock([Response.json(metadata()), new Response(null, { headers: { location } }), Response.json(metadata({ size: String(bytes.length), sha256Checksum: digest(bytes) }))], (url, init, index) => {
    if (index === 1) {
      assert.equal(url.pathname, '/upload/drive/v3/files/file-123');
      assert.equal(url.searchParams.get('uploadType'), 'resumable');
      assert.equal(init.method, 'PATCH');
      assert.deepEqual(JSON.parse(String(init.body)), { mimeType: xlsx });
    } else if (index === 2) {
      assert.equal(init.method, 'PUT');
      assert.deepEqual(init.body, bytes);
    }
  });
  await updateDriveFileContent(credential, { fileId: 'file-123', ...upload({ contentBase64: bytes.toString('base64') }) });
  assert.equal(calls(), 3);
  mock([new Response(null, { headers: { location: location.replace('/file-123?', '?') } }), new Response(null, { status: 308 })]);
  await assert.rejects(uploadDriveFile(credential, upload({ contentBase64: bytes.toString('base64') })), rejected(502, /Check Drive before retrying/));
});

test('Drive content replacement checks regular file metadata and patches exact bytes without replacing permissions', async () => {
  mock([Response.json(metadata({ mimeType: 'application/octet-stream' })), Response.json(metadata())], (url, init, index) => {
    if (index === 0) {
      assert.equal(url.pathname, '/drive/v3/files/file-123');
      assert.equal(init.method, 'GET');
    } else {
      assert.equal(url.pathname, '/upload/drive/v3/files/file-123');
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      assert.equal(init.method, 'PATCH');
      const boundary = new Headers(init.headers).get('content-type')!.match(/^multipart\/related; boundary=(connector_[\w-]+)$/)?.[1];
      assert.ok(boundary);
      const body = init.body as Buffer;
      const delimiter = Buffer.from(`\r\n--${boundary}\r\n`);
      const split = body.indexOf(delimiter);
      assert.deepEqual(JSON.parse(body.subarray(body.indexOf('\r\n\r\n') + 4, split).toString('utf8')), { mimeType: xlsx });
      const bytesStart = body.indexOf('\r\n\r\n', split + delimiter.length) + 4;
      const bytesEnd = body.length - Buffer.byteLength(`\r\n--${boundary}--\r\n`);
      assert.deepEqual(body.subarray(bytesStart, bytesEnd), payload);
    }
  });
  const result = await updateDriveFileContent(credential, { fileId: 'file-123', ...upload() });
  assert.match(result.summary, /Replaced/);
  assert.equal(result.items?.[0].fileId, 'file-123');
  const action = workspaceDriveFileActions.find(entry => entry.definition.id === 'update-file-content')!;
  assert.equal(action.definition.kind, 'write');
  assert.deepEqual(action.requiredScopes, ['https://www.googleapis.com/auth/drive']);
});

test('Drive content replacement refuses Google-native files, shortcuts and mismatched response IDs', async () => {
  for (const mimeType of [sheetMime, 'application/vnd.google-apps.folder', 'application/vnd.google-apps.shortcut']) {
    const calls = mock([Response.json(metadata({ mimeType }))]);
    await assert.rejects(updateDriveFileContent(credential, { fileId: 'file-123', ...upload() }), rejected(400, /regular file bytes only/));
    assert.equal(calls(), 1);
  }
  mock([Response.json(metadata()), Response.json(metadata({ id: 'different-file' }))]);
  await assert.rejects(updateDriveFileContent(credential, { fileId: 'file-123', ...upload() }), rejected(502, /did not confirm the file/));
});

test('Drive does not report replacement success when the provider leaves the wrong MIME type', async () => {
  for (const large of [false, true]) {
    const bytes = large ? Buffer.alloc(5_000_001) : payload;
    const responses = [Response.json(metadata({ mimeType: 'application/octet-stream' }))];
    if (large) responses.push(new Response(null, { headers: { location: 'https://www.googleapis.com/upload/drive/v3/files/file-123?uploadType=resumable&upload_id=private-session' } }));
    responses.push(Response.json(metadata({ mimeType: 'application/octet-stream', size: String(bytes.length), sha256Checksum: digest(bytes) })));
    mock(responses);
    await assert.rejects(updateDriveFileContent(credential, { fileId: 'file-123', ...upload({ contentBase64: bytes.toString('base64') }) }), rejected(502, /did not confirm the requested file type.*Check the file before retrying/));
  }
});

test('Drive exports whole Google Sheets workbooks as exact XLSX bytes', async () => {
  const calls = mock([Response.json(googleMetadata()), new Response(payload, { headers: { 'content-type': xlsx } })], (url, init, index) => {
    assert.equal(init.method, 'GET');
    if (index === 0) assert.equal(url.pathname, '/drive/v3/files/file-123');
    else {
      assert.equal(url.pathname, '/drive/v3/files/file-123/export');
      assert.equal(url.searchParams.get('mimeType'), xlsx);
      assert.equal(new Headers(init.headers).get('accept'), xlsx);
    }
  });
  const result = await exportDriveFile(credential, { fileId: 'file-123', mimeType: xlsx });
  assert.equal(calls(), 2);
  assert.deepEqual(result.items?.[0], { fileId: 'file-123', name: 'Quarterly report.xlsx', mimeType: xlsx, size: payload.length, encoding: 'base64', contentBase64: payload.toString('base64'), sha256: digest(payload) });
  assert.deepEqual(Buffer.from(String(result.items?.[0].contentBase64), 'base64'), payload);
  assert.match(result.summary, /do not print base64 into chat/);
  assert.equal(result.summary.includes('only the first'), false);
});

test('Drive export supports Docs and Slides and describes first-sheet or first-slide formats', async () => {
  for (const [source, target, expected] of [
    ['application/vnd.google-apps.document', 'application/pdf', 'Quarterly report.pdf'],
    ['application/vnd.google-apps.presentation', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Quarterly report.pptx'],
    ['application/vnd.google-apps.presentation', 'image/png', 'Quarterly report.png'],
    [sheetMime, 'text/csv', 'Quarterly report.csv'],
  ]) {
    mock([Response.json(googleMetadata({ mimeType: source })), new Response(payload)]);
    const result = await exportDriveFile(credential, { fileId: 'file-123', mimeType: target });
    assert.equal(result.items?.[0].name, expected);
    assert.equal(result.summary.includes('only the first'), ['image/png', 'text/csv'].includes(target));
  }
});

test('Drive export validates IDs and format compatibility and honors download restrictions', async () => {
  globalThis.fetch = async () => { throw new Error('Unexpected request'); };
  for (const fileId of ['https://example.com/file', '../file', 'file?key=value']) {
    await assert.rejects(exportDriveFile(credential, { fileId, mimeType: xlsx }), rejected(400, /Drive ID/));
  }
  await assert.rejects(exportDriveFile(credential, { fileId: 'file-123', mimeType: 'application/x-unsupported' }), rejected(400, /not supported/));
  for (const details of [metadata(), googleMetadata({ mimeType: 'application/vnd.google-apps.document' })]) {
    const calls = mock([Response.json(details)]);
    await assert.rejects(exportDriveFile(credential, { fileId: 'file-123', mimeType: xlsx }), rejected(400, /not available for this file type/));
    assert.equal(calls(), 1);
  }
  const calls = mock([Response.json(googleMetadata({ capabilities: { canDownload: false } }))]);
  await assert.rejects(exportDriveFile(credential, { fileId: 'file-123', mimeType: xlsx }), rejected(403, /disabled downloading/));
  assert.equal(calls(), 1);
});

test('Drive export cancels oversized streams and declared responses at 10 MiB', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    let chunksRead = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { chunksRead++; controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    mock([Response.json(googleMetadata()), new Response(stream, { headers: declared ? { 'content-length': String(MAX_DRIVE_EXPORT_BYTES + 1) } : {} })]);
    await assert.rejects(exportDriveFile(credential, { fileId: 'file-123', mimeType: xlsx }), rejected(413, /10 MiB/));
    assert.equal(cancelled, true);
    assert.equal(chunksRead, declared ? 0 : 11);
  }
});

test('Drive transfer errors never leak provider response bodies, partial bytes, or network exception content', async () => {
  for (const [status, expected] of [[401, 401], [403, 403], [404, 404], [429, 429], [206, 502], [302, 502], [500, 502]]) {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }), { status });
    mock([response]);
    await assert.rejects(uploadDriveFile(credential, upload()), rejected(expected, /Google Drive/));
    assert.equal(cancelled, true);
  }
  globalThis.fetch = async () => { throw new Error(credential.accessToken); };
  await assert.rejects(uploadDriveFile(credential, upload()), rejected(502, /Check Drive before retrying/));
  mock([Response.json(googleMetadata()), new Response(new ReadableStream({ start(controller) { controller.error(new Error(credential.accessToken)); } }))]);
  await assert.rejects(exportDriveFile(credential, { fileId: 'file-123', mimeType: xlsx }), rejected(502, /did not finish/));
});

test('Drive invalid local credentials fail validation before a request without claiming an uncertain write', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected request'); };
  for (const accessToken of ['', '   ', 'header\rinjection', 'header\ninjection']) {
    await assert.rejects(uploadDriveFile({ accessToken }, upload()), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.equal(error.status, 400);
      assert.match(error.message, /valid API key or access token/);
      assert.doesNotMatch(error.message, /might already|retrying|did not return a response/);
      return true;
    });
  }
  assert.equal(calls, 0);
});

test('Drive oversized upload receipts are uncertain provider failures, including declared and streamed responses', async () => {
  for (const declared of [false, true]) {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.alloc(65 * 1024)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: declared ? { 'content-length': String(65 * 1024) } : {} });
    mock([response]);
    await assert.rejects(uploadDriveFile(credential, upload()), rejected(502, /oversized file details.*Check Drive before retrying.*might already have been accepted/));
    assert.equal(cancelled, true);
  }
});

test('Drive rejects invalid or oversized provider metadata and never follows response redirects', async () => {
  for (const details of [null, [], metadata({ id: '../bad' }), metadata({ name: '\nname' }), metadata({ mimeType: 'x\r\ny' }), metadata({ size: '-1' }), metadata({ sha256Checksum: 'bad' }), { ...metadata(), error: { message: credential.accessToken } }]) {
    mock([Response.json(details)]);
    await assert.rejects(uploadDriveFile(credential, upload()), rejected(502, /file/));
  }
  mock([new Response('invalid json')]);
  await assert.rejects(uploadDriveFile(credential, upload()), rejected(502, /unreadable/));
  mock([new Response(' '.repeat(64 * 1024 + 1))]);
  await assert.rejects(uploadDriveFile(credential, upload()), rejected(502, /oversized.*Check Drive before retrying/));
  const response = Response.json(metadata());
  Object.defineProperty(response, 'redirected', { value: true });
  mock([response]);
  await assert.rejects(uploadDriveFile(credential, upload()), rejected(502, /could not complete/));
});

test('Drive write actions require confirmation through their write definitions and export remains read-only', () => {
  assert.deepEqual(workspaceDriveFileActions.map(action => [action.definition.id, action.definition.kind]), [['upload-file', 'write'], ['update-file-content', 'write'], ['export-file', 'read']]);
  const exported = workspaceDriveFileActions.find(action => action.definition.id === 'export-file')!;
  assert.deepEqual(exported.requiredScopes, ['https://www.googleapis.com/auth/drive.readonly']);
  assert.ok(workspaceDriveFileActions.every(action => action.definition.schedulable !== true));
});
