import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { antigravityHome, checkAntigravitySettings } from '../server/outbound-antigravity-settings.ts';
import { ProviderError } from '../server/provider-types.ts';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FILES = ['antigravity-cli/settings.json', 'config/config.json', 'config/hooks.json', 'config/mcp_config.json'];
type Fixture = {
  root: string; env: NodeJS.ProcessEnv;
  put(relative: string, contents: string | Uint8Array): Promise<string>;
};
async function fixture(callback: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'connector-ag-settings-'));
  try {
    await callback({ root, env: { HOME: root, USERPROFILE: root }, put: async (relative, contents) => {
      const file = path.join(root, '.gemini', ...relative.split('/'));
      await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents); return file;
    } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

function safeError(relative: string, reason: RegExp, root?: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ProviderError);
    assert.ok(error.message.includes(relative));
    assert.match(error.message, reason);
    assert.equal(error.message.includes('private-config-value'), false);
    assert.equal(error.message.includes('private-token-value'), false);
    if (root) assert.equal(error.message.includes(root), false);
    return true;
  };
}

test('missing and empty-object configuration files preserve provider defaults without creating files', async () => {
  await fixture(async f => {
    await checkAntigravitySettings(f.env);
    await assert.rejects(readFile(path.join(f.root, '.gemini', 'antigravity-cli', 'settings.json')), { code: 'ENOENT' });
    for (const file of FILES) await f.put(file, '{}');
    await checkAntigravitySettings(f.env);
  });
});

test('UTF-8 BOM is accepted in all public settings files without rewriting their contents', async () => {
  await fixture(async f => {
    const paths: string[] = [];
    const contents = Buffer.concat([BOM, Buffer.from('{\r\n}\r\n')]);
    for (const file of FILES) paths.push(await f.put(file, contents));
    await checkAntigravitySettings(f.env);
    for (const file of paths) assert.deepEqual(await readFile(file), contents);
  });
});

test('shared configuration BOM normalization still detects Google Cloud ADC', async () => {
  await fixture(async f => {
    await f.put('config/config.json', Buffer.concat([BOM, Buffer.from('{"userSettings":{"enableAdc":true}}')]));
    await assert.rejects(checkAntigravitySettings(f.env), /Turn off Google Cloud ADC/);
  });
});

test('MCP accepts documented line/block comments and trailing commas', async () => {
  await fixture(async f => {
    const source = '\ufeff{\r\n// Windows editor comment\r\n"mcpServers": {/* another comment */}, /* note */\r\n}\r\n';
    const file = await f.put('config/mcp_config.json', source);
    await checkAntigravitySettings(f.env);
    assert.equal(await readFile(file, 'utf8'), source);
  });
});

test('JSONC normalization preserves URL strings, escaped quotes, slash text, and active server settings', async () => {
  await fixture(async f => {
    const value = { mcpServers: { active: {
      serverUrl: 'https://example.com/a//b?value=/*quoted*/',
      headers: { Authorization: 'private-token-value', Description: 'a "quote" then \\ then // literal' },
    } } };
    const source = JSON.stringify(value).replace(/}$/, ', /* actual comment */}');
    await f.put('config/mcp_config.json', source);
    await assert.rejects(checkAntigravitySettings(f.env), (error: unknown) => {
      assert.ok(error instanceof ProviderError);
      assert.match(error.message, /global hooks or MCP servers/);
      assert.equal(error.message.includes('private-token-value'), false);
      return true;
    });
  });
});

test('malformed JSONC is never converted into an empty safe configuration', async () => {
  const values = ['{,}', '{"mcpServers":,}', '{"mcpServers":{},,}', '{"mcpServers":{/* unterminated}',
    '{"mcpServers": {,}}', '{"mcpServers": [ , ]}', '{"mcpServers": {"bad": NaN}}',
    '{mcpServers: {}}', '{"mcpServers": {"bad": "private-config-value}}'];
  for (const source of values) await fixture(async f => {
    await f.put('config/mcp_config.json', source);
    await assert.rejects(checkAntigravitySettings(f.env), safeError('config/mcp_config.json', /malformed JSON/, f.root));
  });
});

test('only MCP configuration accepts JSONC; other documented JSON files remain strict', async () => {
  for (const file of FILES.filter(file => !file.endsWith('mcp_config.json'))) {
    for (const source of ['{/* private-config-value */}', '{"private-config-value":false,}']) await fixture(async f => {
      await f.put(file, source);
      await assert.rejects(checkAntigravitySettings(f.env), safeError(file, /malformed JSON/, f.root));
    });
  }
});

test('valid JSON with unsupported top-level types produces filename-specific diagnostics', async () => {
  for (const file of FILES) for (const source of ['null', '[]', '"private-config-value"', 'false']) await fixture(async f => {
    await f.put(file, source);
    await assert.rejects(checkAntigravitySettings(f.env), safeError(file, /must contain a JSON object/, f.root));
  });
});

test('invalid encodings are distinguished from syntax errors without echoing contents', async () => {
  const cases: [Buffer, RegExp][] = [
    [Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"private-config-value":true}', 'utf16le')]), /uses UTF-16 instead of UTF-8/],
    [Buffer.from([0xfe, 0xff, 0, 123, 0, 125]), /uses UTF-16 instead of UTF-8/],
    [Buffer.from([123, 34, 0xff, 34, 58, 48, 125]), /invalid UTF-8/],
    [Buffer.concat([BOM, BOM, Buffer.from('{}')]), /malformed JSON/],
  ];
  for (const [source, reason] of cases) await fixture(async f => {
    await f.put('config/config.json', source);
    await assert.rejects(checkAntigravitySettings(f.env), safeError('config/config.json', reason, f.root));
  });
});

test('bounded reader refuses oversized files and non-files with distinct safe explanations', async () => {
  await fixture(async f => {
    await f.put('config/config.json', JSON.stringify({ note: 'private-config-value'.repeat(20_000) }));
    await assert.rejects(checkAntigravitySettings(f.env), safeError('config/config.json', /256 KiB/, f.root));
  });
  await fixture(async f => {
    await mkdir(path.join(f.root, '.gemini', 'config', 'config.json'), { recursive: true });
    await assert.rejects(checkAntigravitySettings(f.env), safeError('config/config.json', /not a regular file/, f.root));
  });
});

test('linked settings remain blocked and their target is never rewritten', { skip: process.platform === 'win32' }, async () => {
  await fixture(async f => {
    const target = path.join(f.root, 'target.json');
    await writeFile(target, '{"private-config-value":true}');
    await mkdir(path.join(f.root, '.gemini', 'config'), { recursive: true });
    await symlink(target, path.join(f.root, '.gemini', 'config', 'config.json'));
    await assert.rejects(checkAntigravitySettings(f.env), safeError('config/config.json', /linked file/, f.root));
    assert.equal(await readFile(target, 'utf8'), '{"private-config-value":true}');
  });
});

test('Windows resolves USERPROFILE before unrelated shell HOME and redacts actual folder names', async () => {
  assert.equal(antigravityHome({ HOME: 'D:\\Git-home', USERPROFILE: 'C:\\Users\\Owner' }, 'win32'), 'C:\\Users\\Owner');
  assert.equal(antigravityHome({ Home: 'D:\\Git-home', UserProfile: 'C:\\Users\\Owner' }, 'win32'), 'C:\\Users\\Owner');
  assert.equal(antigravityHome({ HOME: 'D:\\Git-home' }, 'win32', 'C:\\Users\\Fallback'), 'C:\\Users\\Fallback');
  assert.equal(antigravityHome({ HOME: '/home/owner', USERPROFILE: '/different' }, 'linux'), '/home/owner');
  await fixture(async f => {
    const other = path.join(f.root, 'unrelated-shell-home');
    await mkdir(path.join(other, '.gemini', 'config'), { recursive: true });
    await writeFile(path.join(other, '.gemini', 'config', 'config.json'), '{malformed}');
    const env = { HOME: other, USERPROFILE: f.root };
    await checkAntigravitySettings(env, { platform: 'win32' });
    await f.put('config/config.json', '{"private-config-value":');
    await assert.rejects(checkAntigravitySettings(env, { platform: 'win32' }), safeError('%USERPROFILE%\\.gemini\\config\\config.json', /malformed JSON/, f.root));
  });
});

test('subscription, customization, and isolation gates remain effective after parsing compatibility fixes', async () => {
  const cases: [string, unknown, RegExp][] = [
    ['antigravity-cli/settings.json', { modelProvider: 'gemini' }, /Google account sign-in/],
    ['antigravity-cli/settings.json', { useG1Credits: true }, /AI Credit Overages/],
    ['antigravity-cli/settings.json', { statusLine: { command: 'private-config-value' } }, /custom startup script/],
    ['config/hooks.json', { start: { enabled: true, pre: [{ command: 'private-config-value' }] } }, /global hooks or MCP servers/],
    ['config/mcp_config.json', { mcpServers: { active: { command: 'private-config-value' } } }, /global hooks or MCP servers/],
    ['config/plugins/test/plugin.json', {}, /global plugins/],
  ];
  for (const [file, value, expected] of cases) await fixture(async f => {
    await f.put(file, Buffer.concat([BOM, Buffer.from(JSON.stringify(value))]));
    await assert.rejects(checkAntigravitySettings(f.env), (error: unknown) => {
      assert.ok(error instanceof ProviderError); assert.match(error.message, expected);
      assert.equal(error.message.includes('private-config-value'), false); return true;
    });
  });
});
