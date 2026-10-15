import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repository, 'scripts/build-public-site.mjs');
const loader = import.meta.resolve('tsx');
const publicProfile = JSON.parse(await readFile(join(repository, 'client/public-profile.json'), 'utf8')) as { siteUrl: string; customDomain: string };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'connector-public-site-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, '.env'), 'APP_PASSWORD=PRIVATE_PASSWORD_MUST_NOT_BE_PUBLISHED\n');
  await mkdir(join(directory, 'data'));
  await writeFile(join(directory, 'data/private.sqlite'), 'PRIVATE_DATABASE_MUST_NOT_BE_PUBLISHED');
  return {
    directory,
    output: join(directory, 'artifacts/public-site'),
    build: (variables: Record<string, string> = {}) => execFileSync(process.execPath, ['--import', loader, script], {
      cwd: directory,
      env: { ...process.env, SITE_URL: publicProfile.siteUrl, PUBLIC_SITE_CUSTOM_DOMAIN: '', APP_PASSWORD: 'PRIVATE_ENV_SECRET_MUST_NOT_BE_PUBLISHED', ...variables },
      encoding: 'utf8',
    }),
  };
}

async function generatedFiles(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await generatedFiles(directory, relative));
    else files.push(relative);
  }
  return files.sort();
}

async function assertPublicLinks(output: string, basePath: string) {
  for (const page of ['index.html', 'about/index.html', 'privacy/index.html', 'terms/index.html', '404.html']) {
    const html = await readFile(join(output, page), 'utf8');
    assert.match(html, /<html lang="en">/);
    assert.doesNotMatch(html, /<script\b|<form\b|PRIVATE_(?:PASSWORD|DATABASE|ENV_SECRET)|ngrok-free|\/api\//i);
    for (const [, attribute] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      if (/^(https:|mailto:|#)/.test(attribute)) continue;
      assert.ok(attribute.startsWith(`${basePath}/`), `${page}: unprefixed URL ${attribute}`);
      const path = attribute.slice(basePath.length).split(/[?#]/)[0].replace(/^\//, '');
      const localFile = /\.[a-z]+$/.test(path) ? path : `${path.replace(/\/$/, '')}${path ? '/' : ''}index.html`;
      assert.ok((await readFile(join(output, localFile))).length > 0, `${page}: broken local link ${attribute}`);
    }
  }
}

test('public website contains crawlable branding and policy pages without private application files', async t => {
  const f = await fixture(t);
  f.build({ PUBLIC_SITE_CUSTOM_DOMAIN: publicProfile.customDomain });
  assert.deepEqual(await generatedFiles(f.output), ['.nojekyll', '404.html', 'CNAME', 'about/index.html', 'assets/connector-icon.png', 'index.html', 'legal/style.css', 'privacy/index.html', 'terms/index.html', 'tiktokXduTpCHW4SKFGSCTM6kVlGMJwl7SwrjQ.txt', 'tiktokJHIP9WLTJDuZ05sPisnZFOlegxUrQvC2.txt'].sort());
  await assertPublicLinks(f.output, '');
  const home = await readFile(join(f.output, 'index.html'), 'utf8');
  assert.match(home, /Vectre Pay Inc/);
  assert.match(home, /contact@vectrepay\.com/);
  assert.match(home, /href="\/privacy"/);
  assert.match(home, /href="\/terms"/);
  assert.match(home, /Connector/);
  assert.match(home, /social|account integration|account connection/i);
  assert.match(home, /rel="canonical"/);
  assert.ok(home.includes(publicProfile.siteUrl));
  const privacy = await readFile(join(f.output, 'privacy/index.html'), 'utf8');
  assert.match(privacy, /Google|YouTube/);
  assert.match(privacy, /Limited Use/);
  assert.equal(await readFile(join(f.output, 'CNAME'), 'utf8'), `${publicProfile.customDomain}\n`);
  assert.deepEqual(await readFile(join(f.output, 'assets/connector-icon.png')), await readFile(join(repository, 'client/public/assets/connector-icon.png')));
  for (const filename of ['tiktokXduTpCHW4SKFGSCTM6kVlGMJwl7SwrjQ.txt', 'tiktokJHIP9WLTJDuZ05sPisnZFOlegxUrQvC2.txt']) {
    assert.deepEqual(await readFile(join(f.output, filename)), await readFile(join(repository, 'docs/verification', filename)));
  }
  assert.equal(await readFile(join(f.directory, '.env'), 'utf8'), 'APP_PASSWORD=PRIVATE_PASSWORD_MUST_NOT_BE_PUBLISHED\n');
});

test('project Pages builds keep every link within their base path and do not claim a custom domain', async t => {
  const f = await fixture(t);
  f.build({ SITE_URL: 'https://giftedelephant1.github.io/connector/' });
  await assertPublicLinks(f.output, '/connector');
  assert.ok(!(await generatedFiles(f.output)).includes('CNAME'));
  const home = await readFile(join(f.output, 'index.html'), 'utf8');
  assert.match(home, /https:\/\/giftedelephant1\.github\.io\/connector\//);
  assert.doesNotMatch(home, /connector\.vectrepay\.com/);
  // Rebuilding clears only the generated artifact, including a stale CNAME.
  f.build({ PUBLIC_SITE_CUSTOM_DOMAIN: publicProfile.customDomain });
  f.build({ SITE_URL: 'https://giftedelephant1.github.io/connector' });
  assert.ok(!(await generatedFiles(f.output)).includes('CNAME'));
});

test('public site builder rejects unsafe URLs and mismatched domain claims before creating output', async t => {
  const f = await fixture(t);
  const invalidUrls = [
    'http://connector.example', 'https://owner:secret@connector.example', 'https://connector.example/path?password=secret',
    'https://connector.example/#fragment', 'https://connector.example/a/../private', 'https://connector.example/%2e%2e/private',
    'https://connector.example//project', 'https://localhost', 'https://127.0.0.1', 'https://connector.example:444',
    'https://connector.example/"bad', 'https://connector.example\\private', 'https://connector.example/project.name',
  ];
  for (const siteUrl of invalidUrls) {
    const result = spawnSync(process.execPath, ['--import', loader, script], { cwd: f.directory, env: { ...process.env, SITE_URL: siteUrl, PUBLIC_SITE_CUSTOM_DOMAIN: '' }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, siteUrl);
    assert.doesNotMatch(result.stderr, /owner:secret|password=secret/);
  }
  for (const [siteUrl, domain] of [
    ['https://connector.example', 'different.example'], ['https://connector.example/project', 'connector.example'],
    ['https://giftedelephant1.github.io', 'giftedelephant1.github.io'],
  ]) {
    const result = spawnSync(process.execPath, ['--import', loader, script], { cwd: f.directory, env: { ...process.env, SITE_URL: siteUrl, PUBLIC_SITE_CUSTOM_DOMAIN: domain }, encoding: 'utf8' });
    assert.notEqual(result.status, 0, `${siteUrl} (${domain})`);
  }
  await assert.rejects(readdir(f.output), { code: 'ENOENT' });
});
