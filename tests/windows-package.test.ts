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

async function workflowStep(file: string, name: string) {
  const workflow = (await readFile(join(repository, '.github/workflows', file), 'utf8')).replaceAll('\r\n', '\n');
  const marker = `      - name: ${name}\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `Missing workflow step: ${name}`);
  const end = workflow.indexOf('\n      - ', start + marker.length);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test('Windows failure diagnostics remain uploadable without publishing an unsigned runnable archive', async () => {
  const status = await workflowStep('windows-release.yml', 'Record Windows verification status');
  const upload = await workflowStep('windows-release.yml', 'Save verification diagnostics only');
  assert.match(status, /\n        if: always\(\)\n/);
  assert.match(upload, /\n        if: always\(\)\n/);
  const paths = upload.match(/          path: \|\n((?:            [^\n]+\n)+)/)?.[1].trim().split('\n').map(line => line.trim());
  assert.deepEqual(paths, ['artifacts/Connector-Windows.verification.json', 'artifacts/Connector-Windows.zip.sha256', 'artifacts/Connector-Windows.scan.json']);
  const signedStatus = await workflowStep('windows-signed-release.yml', 'Record signed release verification status');
  const signedReports = await workflowStep('windows-signed-release.yml', 'Save verification reports');
  assert.match(signedStatus, /\n        if: always\(\)\n/);
  assert.match(signedReports, /\n        if: always\(\)\n/);
  assert.match(signedReports, /path: reports\/\*\.json/);
  const signedAssets = await workflowStep('windows-signed-release.yml', 'Save verified release assets');
  assert.doesNotMatch(signedAssets, /if:.*(?:always|failure|cancelled)/, 'Release archives must stay behind successful verification.');
});

test('Windows status writers report early failures without including environment credentials', { skip: process.platform !== 'win32' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'connector-windows-diagnostics-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const signingNames = ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'SIGNING_ENDPOINT', 'SIGNING_ACCOUNT', 'SIGNING_CERTIFICATE_PROFILE'];
  for (const scenario of [
    { file: 'windows-release.yml', step: 'Record Windows verification status', path: 'artifacts/Connector-Windows.verification.json', outcomes: { TESTS_OUTCOME: 'failure', PACKAGE_OUTCOME: 'skipped' } },
    { file: 'windows-signed-release.yml', step: 'Record signed release verification status', path: 'reports/windows-release-status.json', outcomes: { CONFIGURATION_OUTCOME: 'failure', SIGN_OUTCOME: 'skipped' } },
  ]) {
    const step = await workflowStep(scenario.file, scenario.step);
    const body = step.split('        run: |\n')[1];
    assert.ok(body);
    const script = body.split('\n').map(line => line.startsWith('          ') ? line.slice(10) : line).join('\n');
    const env: NodeJS.ProcessEnv = { ...process.env, ...scenario.outcomes, GITHUB_SHA: 'fixture-commit', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
      GITHUB_STEP_SUMMARY: join(temp, 'summary.md'), SCAN_OUTCOME: 'skipped', VERIFICATION_OUTCOME: 'failure', GITHUB_TOKEN: 'PRIVATE_TEST_TOKEN_MUST_NOT_APPEAR' };
    for (const name of signingNames) env[name] = '';
    const result = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { cwd: temp, env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const raw = (await readFile(join(temp, scenario.path), 'utf8')).replace(/^\uFEFF/, '');
    const report = JSON.parse(raw);
    assert.equal(report.commit, 'fixture-commit');
    assert.equal(report.runId, '123');
    assert.equal(report.runAttempt, '2');
    assert.equal(report.verificationOutcome, 'failure');
    assert.equal(report.steps.antivirus, 'skipped');
    if (scenario.file === 'windows-release.yml') {
      assert.equal(report.steps.tests, 'failure');
      assert.equal(report.steps.package, 'skipped');
      assert.equal(report.runnablePackagePublished, false);
    } else {
      assert.equal(report.steps.configuration, 'failure');
      assert.equal(report.steps.signing, 'skipped');
      assert.deepEqual(report.missingSigningVariables, signingNames);
    }
    assert.doesNotMatch(raw, /PRIVATE_TEST_TOKEN_MUST_NOT_APPEAR|GITHUB_TOKEN/);
    await assert.rejects(readFile(join(temp, 'artifacts/Connector-Windows.zip')), { code: 'ENOENT' });
  }
});

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
