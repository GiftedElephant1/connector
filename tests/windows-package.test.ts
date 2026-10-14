import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { test, type TestContext } from 'node:test';

const repository = fileURLToPath(new URL('../', import.meta.url));
const packager = join(repository, 'scripts/package-windows.mjs');
async function write(path: string, contents: string | Buffer) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
async function fixture(t: TestContext) {
  const temp = await mkdtemp(join(tmpdir(), 'connector-package-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const source = join(temp, 'source');
  for (const name of ['Start Connector.vbs', 'Update Connector.vbs']) {
    await write(join(source, name), await readFile(join(repository, name)));
  }
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', '.env.example', 'README.md',
    'client/index.tsx', 'server/index.ts', 'scripts/windows-launcher.ps1', 'scripts/windows-update.ps1',
    'scripts/windows-common.ps1', 'scripts/windows-background.ps1', 'docs/windows.md']) {
    await write(join(source, name), `fixture ${name}\n`);
  }
  return { temp, source, stage: join(temp, 'stage'), output: join(temp, 'output') };
}
function run(args: string[]) {
  return spawnSync(process.execPath, [packager, ...args], { encoding: 'utf8' });
}
function zipEntries(bytes: Buffer) {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18);
    const nameLength = bytes.readUInt16LE(offset + 26);
    const extraLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    entries.set(name, inflateRawSync(bytes.subarray(start, start + length)));
    offset = start + length;
  }
  return entries;
}

test('release staging preserves source and excludes private data; ZIP preserves staged bytes', async t => {
  const f = await fixture(t);
  const original = await readFile(join(f.source, 'Start Connector.vbs'));
  for (const name of ['.env', 'data/connector.sqlite', 'server/.env.local', 'server/private.key', 'client/node_modules/private.js', 'scripts/artifacts/old.zip']) {
    await write(join(f.source, name), 'private fixture must not ship');
  }
  const stage = run(['--source', f.source, '--stage', f.stage]);
  assert.equal(stage.status, 0, stage.stderr);
  assert.deepEqual(await readFile(join(f.source, 'Start Connector.vbs')), original);
  for (const name of ['Start Connector.vbs', 'Update Connector.vbs']) {
    const launcher = await readFile(join(f.stage, name), 'utf8');
    assert.match(launcher, /-ExecutionPolicy AllSigned -WindowStyle Normal/);
    assert.match(launcher, /-HideLaunchConsole/);
    assert.match(launcher, /shell.Run\(command, 1, False\)/);
    assert.doesNotMatch(launcher, /ExecutionPolicy Bypass/);
  }
  // Simulate opaque post-staging bytes (not a real signature). Archiving must
  // preserve them verbatim; actual signature trust is a separate Windows gate.
  const script = join(f.stage, 'scripts/windows-launcher.ps1');
  const contents = Buffer.concat([await readFile(script), Buffer.from('\r\n# opaque signing bytes\r\n')]);
  await writeFile(script, contents);
  const packaged = run([f.output, '--source', f.stage]);
  assert.equal(packaged.status, 0, packaged.stderr);
  const entries = zipEntries(await readFile(join(f.output, 'Connector-Windows.zip')));
  assert.deepEqual(entries.get('Connector/scripts/windows-launcher.ps1'), contents);
  assert.equal(entries.has('Connector/.env.example'), true);
  for (const [name, value] of entries) {
    assert.equal(value.includes('private fixture must not ship'), false, name);
  }
  const restage = run(['--source', f.source, '--stage', f.stage]);
  assert.notEqual(restage.status, 0, 'Must reject stale stage directories.');
  assert.deepEqual(await readFile(script), contents);
});

test('signed packaging fails closed for unsigned scripts and writes no release archive', async t => {
  const f = await fixture(t);
  const stage = run(['--source', f.source, '--stage', f.stage]);
  assert.equal(stage.status, 0, stage.stderr);
  const result = run([f.output, '--source', f.stage, '--signed']);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /signature verification failed|Windows Authenticode verification/);
  await assert.rejects(readdir(f.output), { code: 'ENOENT' });
});
