import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkLocal, localEnvironment, resolveWindowsNpmEntry, runLocal, type LocalProvider } from '../server/outbound-local.ts';
import { ProviderError } from '../server/provider-types.ts';

interface Fixture {
  root: string; home: string; executable: string; workspace: string; invocation: string;
  freshWorkspace(): Promise<string>;
}

async function fixture<T>(provider: LocalProvider, callback: (f: Fixture) => Promise<T>, options: {
  authMethod?: string; authenticated?: boolean; script?: string;
} = {}): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'connector-local-test-'));
  const home = path.join(root, 'user');
  const workspace = path.join(root, 'task');
  await mkdir(home); await mkdir(workspace);
  const invocation = path.join(root, 'invocation.json');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('1.4.4'); process.exit(0); }
if (args.includes('status')) {
  if (${JSON.stringify(provider)} === 'claude') console.log(JSON.stringify({loggedIn:${options.authenticated !== false},authMethod:${JSON.stringify(options.authMethod ?? 'claude.ai')}}));
  else console.error(${JSON.stringify(options.authMethod === 'api_key' ? 'API key configured - secret-fragment' : options.authenticated === false ? 'Not logged in' : 'Logged in using ChatGPT')});
  process.exit(${options.authenticated === false ? 1 : 0});
}
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', text => input += text);
process.stdin.on('end', () => {
  fs.writeFileSync(${JSON.stringify(invocation)},JSON.stringify({args,input,cwd:process.cwd(),env:process.env}));
  ${options.script ?? `
  const result = JSON.stringify({args,input,cwd:process.cwd(),env:process.env});
  if (${JSON.stringify(provider)} === 'claude') console.log(JSON.stringify({type:'result',is_error:false,result}));
  else if (${JSON.stringify(provider)} === 'chatgpt') {
    console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:result}}));
    console.log(JSON.stringify({type:'turn.completed',usage:{}}));
  } else {
    console.log(JSON.stringify({event:'init',init:{tools:[]}}));
    console.log(JSON.stringify({event:'result',result:{status:'SUCCESS',response:result}}));
  }`}
});
`;
  let executable: string;
  if (process.platform === 'win32') {
    // Exercise the same npm-shim bypass used by installed official CLIs.
    const name = provider === 'chatgpt' ? 'codex' : 'claude';
    const pkg = provider === 'chatgpt' ? '@openai/codex' : '@anthropic-ai/claude-code';
    executable = path.join(root, `${name}.cmd`);
    await writeFile(executable, '@echo THIS_SHIM_MUST_NEVER_RUN\r\n');
    const pkgRoot = path.join(root, 'node_modules', pkg);
    await mkdir(path.join(pkgRoot, 'bin'), { recursive: true });
    await writeFile(path.join(pkgRoot, 'package.json'), JSON.stringify({ name: pkg }));
    await writeFile(path.join(pkgRoot, provider === 'chatgpt' ? 'bin/codex.js' : 'cli.js'), script);
  } else {
    executable = path.join(root, 'official tool; $(not-a-shell)');
    await writeFile(executable, script, { mode: 0o700 });
    await chmod(executable, 0o700);
  }
  const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  let count = 0;
  try { return await callback({ root, home, executable, workspace, invocation, freshWorkspace: async () => {
    const dir = path.join(root, `task-${++count}`); await mkdir(dir); return dir;
  } }); }
  finally {
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
}

function publicError(error: unknown): boolean {
  assert.ok(error instanceof ProviderError);
  assert.equal(error.message.includes('secret-fragment'), false);
  assert.equal(error.message.includes('UPSTREAM_PRIVATE'), false);
  return true;
}

test('local child environment retains only OS authentication essentials and drops billing/Connector secrets', () => {
  const env = localEnvironment({
    HOME: '/home/user', Path: 'C:\\bin', SystemRoot: 'C:\\Windows', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    OPENAI_API_KEY: 'private', CODEX_API_KEY: 'private', CODEX_HOME: '/secret/alternate-auth',
    ANTHROPIC_API_KEY: 'private', CLAUDE_CODE_OAUTH_TOKEN: 'private', GOOGLE_API_KEY: 'private', GEMINI_API_KEY: 'private',
    AGY_ADC_AUTH: 'true', GOOGLE_APPLICATION_CREDENTIALS: '/secret/adc.json', CONNECTOR_MASTER_KEY: 'private',
    NODE_OPTIONS: '--require /private/hook.js', BASH_ENV: '/private/startup', HTTP_PROXY: 'https://private:password@proxy',
    CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  });
  assert.deepEqual(Object.keys(env).sort(), ['CLAUDE_CODE_DISABLE_FAST_MODE', 'DBUS_SESSION_BUS_ADDRESS', 'HOME', 'NO_COLOR', 'Path', 'SystemRoot', 'TERM'].sort());
  assert.equal(env.CLAUDE_CODE_DISABLE_FAST_MODE, '1');
});

test('Claude tasks use subscription auth, stdin, no shell interpolation, and strict tool/config restrictions', async () => {
  await fixture('claude', async f => {
    assert.equal((await checkLocal('claude', { executable: f.executable })).status, 'ready');
    const prompt = '/some-command\nExplain $(not-a-command) and `literal` "quotes"; keep this text.';
    const result = await runLocal('claude', { executable: f.executable }, prompt, { cwd: f.workspace });
    const run = JSON.parse(result.result);
    assert.equal(run.input, prompt);
    assert.equal(run.cwd, f.workspace);
    assert.equal(run.args.includes(prompt), false);
    assert.deepEqual(run.args.slice(0, 2), ['--safe-mode', '--restricted']);
    assert.equal(run.args[run.args.indexOf('--tools') + 1], '');
    assert.equal(run.args[run.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(run.args[run.args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
    for (const flag of ['--strict-mcp-config', '--disable-slash-commands', '--no-session-persistence']) assert.ok(run.args.includes(flag));
    assert.equal(run.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(run.args.includes('--bare'), false);
  });
});

test('saved API-key or token logins are refused without leaking auth output or sending a task', async () => {
  for (const provider of ['claude', 'chatgpt'] as const) {
    for (const authMethod of provider === 'claude' ? ['api_key', 'oauth_token', 'api_key_helper', 'third_party'] : ['api_key']) {
      await fixture(provider, async f => {
        const check = await checkLocal(provider, { executable: f.executable });
        assert.equal(check.authenticated, false);
        assert.equal(check.message.includes('secret-fragment'), false);
        await assert.rejects(runLocal(provider, { executable: f.executable }, 'Do not send', { cwd: f.workspace }), publicError);
        await assert.rejects(readFile(f.invocation), { code: 'ENOENT' });
      }, { authMethod });
    }
  }
});

test('Codex uses exec-scoped ignore-user-config, restrictive named permissions, and completed result events', async () => {
  await fixture('chatgpt', async f => {
    const result = await runLocal('chatgpt', { executable: f.executable }, 'Describe a payment service', { cwd: f.workspace });
    const run = JSON.parse(result.result);
    assert.deepEqual(run.args.slice(0, 3), ['exec', '--ignore-user-config', '--strict-config']);
    assert.ok(run.args.includes('forced_login_method="chatgpt"'));
    assert.ok(run.args.includes('default_permissions="connector-text"'));
    assert.ok(run.args.includes('permissions.connector-text.network.enabled=false'));
    assert.ok(run.args.includes('permissions.connector-text.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"},":tmpdir"="deny",":slash_tmp"="deny"}'));
    for (const feature of ['shell_tool', 'unified_exec', 'js_repl', 'plugins', 'apps', 'hooks', 'browser_use', 'computer_use', 'multi_agent']) {
      assert.ok(run.args.includes(`features.${feature}=false`));
    }
    assert.equal(run.args.includes('--sandbox'), false);
    assert.equal(run.args.at(-1), '-');
    assert.equal(run.input, 'Describe a payment service');
  });
});

test('Gemini uses one official streaming input event and a no-tools custom main agent', { skip: process.platform === 'win32' }, async () => {
  await fixture('gemini', async f => {
    const check = await checkLocal('gemini', { executable: f.executable });
    assert.equal(check.status, 'unverified');
    assert.equal(check.authenticated, null);
    const prompt = '/unsafe-slash-command\n"Task text"';
    const run = JSON.parse((await runLocal('gemini', { executable: f.executable }, prompt, { cwd: f.workspace })).result);
    assert.deepEqual(JSON.parse(run.input), { event: 'user', message: { content: prompt } });
    assert.equal(run.args[run.args.indexOf('--input-format') + 1], 'stream-json');
    assert.equal(run.args[run.args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(run.args.includes('--disable-slash-commands'));
    assert.equal(run.args.includes('--dangerously-skip-permissions'), false);
    const name = run.args[run.args.indexOf('--agent') + 1];
    const agent = await readFile(path.join(f.workspace, '.agents', 'agents', name, 'agent.md'), 'utf8');
    for (const line of ['mainAgent: true', 'subagent: false', 'tools: []', 'mcpServers: []', 'skills: []', 'plugins: []', 'commandExecutionPolicy: off']) assert.ok(agent.includes(line));
  });
});

test('Gemini fails closed on configured API billing, extra credits, global hooks, MCP, and plugins', { skip: process.platform === 'win32' }, async () => {
  const cases: [string, unknown][] = [
    ['antigravity-cli/settings.json', { modelProvider: 'gemini' }],
    ['antigravity-cli/settings.json', { useG1Credits: true }],
    ['antigravity-cli/settings.json', { statusLine: { command: 'private-command' } }],
    ['config/config.json', { userSettings: { enableAdc: true } }],
    ['config/hooks.json', { hooks: { start: [{ command: 'private-command' }] } }],
    ['config/mcp_config.json', { mcpServers: { private: { command: 'private-command' } } }],
    ['config/plugins/custom/plugin.json', { name: 'private-plugin' }],
  ];
  for (const [relative, value] of cases) await fixture('gemini', async f => {
    const file = path.join(f.home, '.gemini', relative);
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value));
    await assert.rejects(runLocal('gemini', { executable: f.executable }, 'Do not send', { cwd: f.workspace }), publicError);
    await assert.rejects(readFile(f.invocation), { code: 'ENOENT' });
  });
});

test('malformed, failed, and incomplete outputs never become successful tasks or expose provider diagnostics', async () => {
  for (const [provider, script] of [
    ['claude', 'console.error("UPSTREAM_PRIVATE"); process.exitCode = 7;'],
    ['claude', 'console.log(JSON.stringify({type:"result",is_error:true,result:"UPSTREAM_PRIVATE"}));'],
    ['chatgpt', 'console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"UPSTREAM_PRIVATE"}}));'],
    ['chatgpt', 'console.log(JSON.stringify({type:"turn.failed",error:{message:"UPSTREAM_PRIVATE"}}));'],
  ] as const) await fixture(provider, async f => {
    await assert.rejects(runLocal(provider, { executable: f.executable }, 'test', { cwd: f.workspace }), publicError);
  }, { script });
});

test('stdout and stderr share a bounded output budget and oversized subprocesses are stopped', async () => {
  await fixture('claude', async f => {
    const started = Date.now();
    await assert.rejects(runLocal('claude', { executable: f.executable }, 'test', { cwd: f.workspace }), /output limit/);
    assert.ok(Date.now() - started < 10_000);
  }, { script: 'process.stderr.write("x".repeat(2 * 1024 * 1024 + 1)); setInterval(()=>{},1000);' });
});

test('cancelling a live task waits for its process group to stop', { skip: process.platform === 'win32' }, async () => {
  await fixture('claude', async f => {
    const controller = new AbortController();
    const pending = runLocal('claude', { executable: f.executable }, 'test', { cwd: f.workspace, signal: controller.signal });
    const rejected = assert.rejects(pending, (error: unknown) => {
      assert.ok(error instanceof ProviderError); assert.equal(error.status, 409); return true;
    });
    let pid: number | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { pid = Number(await readFile(path.join(f.root, 'pid'), 'utf8')); break; } catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(pid);
    controller.abort(); await rejected;
    assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  }, { script: 'fs.writeFileSync(require("node:path").join(require("node:path").dirname(process.cwd()), "pid"),String(process.pid)); setInterval(()=>{},1000);' });
});

test('the five-minute task limit terminates a stalled client without waiting five real minutes', async t => {
  await fixture('claude', async f => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pending = runLocal('claude', { executable: f.executable }, 'test', { cwd: f.workspace });
      const rejected = assert.rejects(pending, (error: unknown) => {
        assert.ok(error instanceof ProviderError); assert.equal(error.status, 504); assert.match(error.message, /timed out/); return true;
      });
      const deadline = Date.now() + 5000;
      let started = false;
      while (Date.now() < deadline) {
        try { await readFile(f.invocation); started = true; break; }
        catch { await new Promise<void>(resolve => setImmediate(resolve)); }
      }
      assert.ok(started);
      t.mock.timers.tick(5 * 60_000 + 1);
      await rejected;
    } finally { t.mock.timers.reset(); }
  }, { script: 'setInterval(()=>{},1000);' });
});

test('unsupported safety flags never cause a retry with weaker permissions', async () => {
  await fixture('claude', async f => {
    await assert.rejects(runLocal('claude', { executable: f.executable }, 'test', { cwd: f.workspace }), /required isolation options were rejected/);
    const invocation = JSON.parse(await readFile(f.invocation, 'utf8'));
    assert.ok(invocation.args.includes('--safe-mode'));
  }, { script: 'console.error("unknown option --safe-mode UPSTREAM_PRIVATE"); process.exitCode=2;' });
});

test('already cancelled tasks and nonempty workspaces never start a CLI', async () => {
  await fixture('claude', async f => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runLocal('claude', { executable: f.executable }, 'test', { cwd: f.workspace, signal: controller.signal }), /cancelled/);
    await writeFile(path.join(f.workspace, 'private.txt'), 'private');
    await assert.rejects(runLocal('claude', { executable: f.executable }, 'test', { cwd: f.workspace }), /empty local directory/);
    await assert.rejects(readFile(f.invocation), { code: 'ENOENT' });
  });
});

test('executable validation refuses command text and reports missing installations', async () => {
  for (const executable of ['claude --print', './claude', 'https://example.com/cli', '/tmp/tool\nother-command']) {
    await assert.rejects(checkLocal('claude', { executable }), /absolute local file path/);
  }
  assert.equal((await checkLocal('claude', { executable: path.join(tmpdir(), 'does-not-exist-connector-cli') })).status, 'not_installed');
});

test('Windows npm shim resolution verifies package identity and never executes arbitrary cmd content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'connector-shim-test-'));
  try {
    const shim = path.join(root, 'codex.cmd');
    const pkg = path.join(root, 'node_modules', '@openai', 'codex');
    await mkdir(path.join(pkg, 'bin'), { recursive: true });
    await writeFile(shim, 'malicious shell content is never read or run');
    await writeFile(path.join(pkg, 'package.json'), '{"name":"@openai/codex"}');
    await writeFile(path.join(pkg, 'bin', 'codex.js'), '// known entry');
    assert.equal(await resolveWindowsNpmEntry('chatgpt', shim), await import('node:fs/promises').then(fs => fs.realpath(path.join(pkg, 'bin', 'codex.js'))));
    await writeFile(path.join(pkg, 'package.json'), '{"name":"unrelated-package"}');
    await assert.rejects(resolveWindowsNpmEntry('chatgpt', shim), /could not be verified/);
    await assert.rejects(resolveWindowsNpmEntry('chatgpt', path.join(root, 'other.cmd')), /Arbitrary Windows command scripts/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('installed Codex accepts the exact task CLI flag placement without contacting a model', { skip: process.platform !== 'linux' }, async t => {
  const executable = '/opt/codex/bin/codex';
  try { await readFile(executable); } catch { t.skip('Official Codex executable not installed in this test environment.'); return; }
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(executable, ['exec', '--ignore-user-config', '--strict-config', '--ephemeral', '--skip-git-repo-check', '--json', '--help'], {
      shell: false, env: localEnvironment(), stdio: 'ignore',
    });
    child.on('error', reject); child.on('close', resolve);
  });
  assert.equal(code, 0);
});
