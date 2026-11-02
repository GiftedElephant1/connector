import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ProviderError } from './provider-types';
import { checkAntigravitySettings } from './outbound-antigravity-settings';

export type LocalProvider = 'claude' | 'chatgpt' | 'gemini';
export interface LocalConfig { executable?: string }
export interface LocalCheck {
  available: boolean;
  authenticated: boolean | null;
  status: 'ready' | 'not_installed' | 'sign_in_required' | 'unverified' | 'unsupported';
  message: string;
  version?: string;
}
export interface LocalRunOptions { cwd: string; signal?: AbortSignal }

const NAMES = { claude: 'Claude Code', chatgpt: 'Codex', gemini: 'Antigravity' };
const BINS = { claude: 'claude', chatgpt: 'codex', gemini: 'agy' };
const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_RESULT = 200_000;
const CHECK_TIMEOUT = 15_000;
const TASK_TIMEOUT = 5 * 60_000;
const CLAUDE_SAFE = ['--safe-mode', '--restricted'];
const CLAUDE_TASK = ['-p', '--output-format', 'json', '--tools', '', '--disallowedTools', '*',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands',
  '--permission-mode', 'dontAsk', '--permission-prompts', 'none', '--no-session-persistence', '--max-turns', '1'];

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);
interface Command { executable: string; prefix: string[] }
interface Captured { code: number | null; stdout: string; stderr: string }

// Deliberately do not inherit process.env. Connector's vault keys, platform
// credentials, API billing overrides, NODE_OPTIONS, proxy credentials and shell
// startup hooks must never enter an agent process. The official CLI accesses its
// own account using the OS user's existing home/keyring; Connector never reads it.
export function localEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  }
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  env.CLAUDE_CODE_DISABLE_FAST_MODE = '1';
  return env;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

async function executableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

async function findBinary(name: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dirs = (envValue(env, 'PATH') ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir));
  const home = envValue(env, 'USERPROFILE') || envValue(env, 'HOME') || homedir();
  // Official native installers use this directory, which may not yet be present
  // in the already-running Connector process's PATH.
  dirs.push(path.join(home, '.local', 'bin'));
  if (process.platform === 'win32' && envValue(env, 'APPDATA')) dirs.push(path.join(envValue(env, 'APPDATA')!, 'npm'));
  for (const dir of [...new Set(dirs)]) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd'] : ['']) {
      const file = path.join(dir, name + suffix);
      if (await executableFile(file)) return file;
    }
  }
  return undefined;
}

/** Resolve known npm shims without ever passing their contents to cmd.exe. */
export async function resolveWindowsNpmEntry(provider: LocalProvider, file: string): Promise<string> {
  const packages = { claude: ['@anthropic-ai/claude-code', 'cli.js'], chatgpt: ['@openai/codex', 'bin/codex.js'] };
  const expected = provider === 'gemini' ? undefined : packages[provider];
  if (!expected || path.basename(file).toLowerCase() !== `${BINS[provider]}.cmd`) {
    throw new ProviderError('Choose the official native executable. Arbitrary Windows command scripts cannot be used for AI tasks.');
  }
  const root = path.join(path.dirname(file), 'node_modules', expected[0]);
  try {
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (!object(manifest) || manifest.name !== expected[0]) throw new Error('Wrong package');
    const entry = path.join(root, expected[1]);
    if (!(await stat(entry)).isFile()) throw new Error('Missing entry');
    const actualRoot = await realpath(root);
    const actualEntry = await realpath(entry);
    if (!actualEntry.startsWith(actualRoot + path.sep)) throw new Error('Outside package');
    return actualEntry;
  } catch {
    throw new ProviderError(`The ${NAMES[provider]} npm installation could not be verified. Reinstall its official CLI or select its native executable.`);
  }
}

async function resolveCommand(provider: LocalProvider, config: LocalConfig, env: NodeJS.ProcessEnv): Promise<Command | undefined> {
  let file = config.executable;
  if (file !== undefined && (typeof file !== 'string' || !path.isAbsolute(file) || /[\0\r\n]/.test(file))) {
    throw new ProviderError('The executable must be an absolute local file path, without arguments.');
  }
  file ||= await findBinary(BINS[provider], env);
  if (!file || !(await executableFile(file))) return undefined;
  const extension = path.extname(file).toLowerCase();
  if (process.platform === 'win32') {
    if (extension === '.cmd') {
      const entry = await resolveWindowsNpmEntry(provider, file);
      let node = path.join(path.dirname(file), 'node.exe');
      if (!(await executableFile(node))) node = await findBinary('node', env) || '';
      if (!node || path.extname(node).toLowerCase() !== '.exe') throw new ProviderError('Install Node.js or select the official native AI executable.');
      return { executable: node, prefix: [entry] };
    }
    if (extension !== '.exe') throw new ProviderError('Choose an official .exe executable or supported npm .cmd launcher.');
  } else if (['.cmd', '.bat', '.ps1'].includes(extension)) {
    throw new ProviderError('Choose an executable installed for this operating system.');
  }
  return { executable: file, prefix: [] };
}

async function killOwnTree(child: ChildProcess): Promise<boolean> {
  if (!child.pid) return true;
  if (process.platform === 'win32') {
    // PID is generated by spawn, never supplied by the caller. Use Windows's
    // own binary by absolute path, not an executable discovered on PATH.
    const systemRoot = envValue(process.env, 'SYSTEMROOT') || 'C:\\Windows';
    return await new Promise<boolean>(resolve => {
      const killer = spawn(path.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        shell: false, windowsHide: true, stdio: 'ignore', env: localEnvironment(),
      });
      let done = false;
      const finish = (stopped: boolean) => {
        if (done) return; done = true; clearTimeout(timer); resolve(stopped);
      };
      const timer = setTimeout(() => { try { killer.kill(); } catch { /* Already closed. */ } finish(false); }, 4000);
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch { /* Already closed. */ } finish(false); });
      killer.on('close', code => finish(code === 0));
    });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); return true; }
    catch (error) {
      if (object(error) && error.code === 'ESRCH') return true;
      try { child.kill('SIGKILL'); } catch { /* Already closed. */ }
      return false;
    }
  }
}

async function capture(command: Command, args: string[], env: NodeJS.ProcessEnv, options: {
  cwd?: string; input?: string; signal?: AbortSignal; timeoutMs: number;
}): Promise<Captured> {
  if (options.signal?.aborted) throw new ProviderError('The AI task was cancelled.', 409);
  return await new Promise<Captured>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(command.executable, [...command.prefix, ...args], {
        cwd: options.cwd, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { reject(new ProviderError('The official AI executable could not be started. Check its installation.')); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0, settled = false, closed = false, stopped: boolean | undefined;
    let failure: ProviderError | undefined, closeCode: number | null = null;
    let stopTimer: NodeJS.Timeout | undefined;
    const finish = (error?: ProviderError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(stopTimer);
      options.signal?.removeEventListener('abort', cancelled);
      if (error) {
        child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy();
        reject(error);
      } else resolve({ code: closeCode, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    };
    const stopUnconfirmed = () => finish(new ProviderError('Connector could not confirm that the AI process stopped. Check the official app and running processes before retrying.', 502));
    const settleStop = () => {
      if (closed && stopped !== undefined) stopped ? finish(failure) : stopUnconfirmed();
    };
    const stop = (error: ProviderError) => {
      if (settled || failure) return;
      failure = error;
      clearTimeout(timer);
      stopTimer = setTimeout(stopUnconfirmed, 5000);
      void killOwnTree(child).then(value => { stopped = value; settleStop(); }).catch(() => { stopped = false; settleStop(); });
    };
    const cancelled = () => stop(new ProviderError('The AI task was cancelled.', 409));
    const timer = setTimeout(() => stop(new ProviderError('The AI task timed out. Its local process was stopped; review provider usage before retrying.', 504)), options.timeoutMs);
    options.signal?.addEventListener('abort', cancelled, { once: true });
    if (options.signal?.aborted) cancelled();
    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      if (settled || failure) return;
      size += chunk.length;
      if (size > MAX_OUTPUT) stop(new ProviderError('The AI response exceeded Connector’s output limit. Its local process was stopped.', 502));
      else chunks.push(chunk);
    };
    child.stdout?.on('data', collect(stdout));
    child.stderr?.on('data', collect(stderr));
    child.on('error', () => finish(new ProviderError('The official AI executable could not be started. Check its installation.')));
    child.on('close', code => { closed = true; closeCode = code; if (failure) settleStop(); else finish(); });
    child.stdin?.on('error', () => { /* Exit handling reports the provider failure without echoing stdin. */ });
    child.stdin?.end(options.input || '');
  });
}

function unavailable(provider: LocalProvider): LocalCheck {
  return { available: false, authenticated: null, status: 'not_installed', message: `Install the official ${NAMES[provider]} CLI on this computer, sign in there, then check again.` };
}

function signIn(provider: LocalProvider): LocalCheck {
  const command = provider === 'claude' ? 'claude auth login' : 'codex login';
  return { available: true, authenticated: false, status: 'sign_in_required', message: `Sign in to ${NAMES[provider]} with your subscription account using ${command}. API-key authentication is not used for this connection.` };
}

function unsupportedOptions(output: string): boolean {
  return /(?:unknown|unrecognized|unexpected|invalid) (?:option|argument|flag)|unknown command/i.test(output);
}

async function authCheck(provider: 'claude' | 'chatgpt', command: Command, env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<LocalCheck> {
  const args = provider === 'claude' ? [...CLAUDE_SAFE, 'auth', 'status'] : ['login', 'status'];
  const reply = await capture(command, args, env, { timeoutMs: CHECK_TIMEOUT, signal });
  if (reply.code !== 0 && unsupportedOptions(reply.stderr + '\n' + reply.stdout)) {
    return { available: true, authenticated: null, status: 'unsupported', message: `Update ${NAMES[provider]} to its current official version. This installation does not support Connector’s required isolation options.` };
  }
  let authenticated = false;
  if (reply.code === 0) {
    if (provider === 'claude') {
      try { const value: unknown = JSON.parse(reply.stdout); authenticated = object(value) && value.loggedIn === true && value.authMethod === 'claude.ai'; } catch { /* Fail closed. */ }
    } else authenticated = /^(?:Logged in using ChatGPT)\s*$/m.test(reply.stderr + '\n' + reply.stdout);
  }
  return authenticated
    ? { available: true, authenticated: true, status: 'ready', message: `${NAMES[provider]} reports a saved subscription sign-in. A task has not been sent; provider limits and account eligibility still apply.` }
    : signIn(provider);
}

export async function checkLocal(provider: LocalProvider, config: LocalConfig): Promise<LocalCheck> {
  const env = localEnvironment();
  const command = await resolveCommand(provider, config, env);
  if (!command) return unavailable(provider);
  if (provider !== 'gemini') return await authCheck(provider, command, env);
  await checkAntigravitySettings(env);
  const version = await capture(command, ['--version'], env, { timeoutMs: CHECK_TIMEOUT });
  if (version.code !== 0) return { available: true, authenticated: null, status: 'unsupported', message: 'Antigravity could not report its version. Update its official CLI and try again.' };
  // No official no-model-call auth-status command is documented for agy. Never
  // invent one or report that --version verifies account credentials.
  return { available: true, authenticated: null, status: 'unverified', message: 'Antigravity is installed. Run agy once and sign in with your personal Google account. Sending a task verifies its saved sign-in and uses your plan allowance.' };
}

function codexArgs(): string[] {
  const config: Record<string, unknown> = {
    forced_login_method: 'chatgpt', model_provider: 'openai', web_search: 'disabled', approval_policy: 'never',
    notify: [], project_doc_max_bytes: 0, 'plugins._default.enabled': false, 'skills.bundled.enabled': false, 'skills.include_instructions': false,
    default_permissions: 'connector-text', 'permissions.connector-text.network.enabled': false,
  };
  for (const feature of ['shell_tool', 'unified_exec', 'js_repl', 'apps', 'connectors', 'plugins', 'hooks', 'codex_hooks', 'plugin_hooks',
    'browser_use', 'computer_use', 'image_generation', 'view_image', 'multi_agent', 'collab', 'memory_tool', 'memories', 'tool_suggest',
    'skill_search', 'skill_mcp_dependency_install']) config[`features.${feature}`] = false;
  // Official named permission profiles restrict private-file reads as well as
  // writes. They are incompatible with the older --sandbox switch. Unsupported
  // installs must fail; never retry with a weaker sandbox or approval bypass.
  return ['exec', '--ignore-user-config', '--strict-config', ...Object.entries(config).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`]),
    '-c', 'permissions.connector-text.filesystem={":root"="deny",":minimal"="read",":workspace_roots"={"."="read"},":tmpdir"="deny",":slash_tmp"="deny"}',
    '--ephemeral', '--skip-git-repo-check', '--json', '-'];
}

function parseResult(provider: LocalProvider, output: string): string {
  let result: string | undefined;
  try {
    if (provider === 'chatgpt') {
      const lines = output.trim().split('\n').map(line => JSON.parse(line) as unknown);
      const messages: string[] = [];
      let completed = false;
      for (const event of lines) {
        if (!object(event)) throw new Error('Invalid event');
        if (['error', 'turn.failed'].includes(String(event.type))) throw new Error('Failed task');
        if (event.type === 'turn.completed') completed = true;
        if (event.type === 'item.completed' && object(event.item) && event.item.type === 'agent_message' && typeof event.item.text === 'string') messages.push(event.item.text);
      }
      if (completed && messages.length) result = messages.join('\n\n');
    } else if (provider === 'gemini') {
      const events: unknown[] = output.trim().split('\n').map(line => JSON.parse(line));
      const completed = events.filter(event => object(event) && event.event === 'result');
      // Exactly one input task is sent. A second result is never silently folded
      // into the first, and partial streamed text is never treated as success.
      if (completed.length === 1 && object(completed[0]) && object(completed[0].result)) {
        const value = completed[0].result;
        if (value.status === 'SUCCESS' && typeof value.response === 'string') result = value.response;
      }
    } else {
      const value: unknown = JSON.parse(output);
      if (object(value)) {
        if (provider === 'claude' && value.type === 'result' && value.is_error === false && typeof value.result === 'string') result = value.result;
      }
    }
  } catch { /* Provider details can contain credentials, so never echo them. */ }
  if (result === undefined || !result.trim()) throw new ProviderError('The AI agent did not return a completed text response. Review the task in its official app before retrying.', 502);
  const clean = result.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  return clean.slice(0, MAX_RESULT) + (clean.length > MAX_RESULT ? '\n\n[Connector truncated this response.]' : '');
}

export async function runLocal(provider: LocalProvider, config: LocalConfig, prompt: string, options: LocalRunOptions): Promise<{ result: string }> {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16_000) throw new ProviderError('Enter a task prompt of 1–16,000 characters.');
  if (!path.isAbsolute(options.cwd)) throw new ProviderError('An isolated task workspace is required.');
  const info = await lstat(options.cwd);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(options.cwd)).length) throw new ProviderError('The AI task workspace must be an empty local directory.');
  const env = localEnvironment();
  const command = await resolveCommand(provider, config, env);
  if (!command) throw new ProviderError(unavailable(provider).message);
  let args: string[];
  if (provider === 'gemini') {
    await checkAntigravitySettings(env);
    const name = `connector-text-${randomUUID()}`;
    const dir = path.join(options.cwd, '.agents', 'agents', name);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path.join(dir, 'agent.md'), `---\nname: ${name}\ndescription: Answer one text task without tools.\nmainAgent: true\nsubagent: false\ninheritCustomizations: false\ntools: []\nmcpServers: []\nskills: []\nplugins: []\ncommandExecutionPolicy: off\n---\nAnswer the supplied task using only the text provided. Do not claim to have inspected files, used tools, or changed external accounts.\n`, { flag: 'wx', mode: 0o600 });
    args = ['--agent', name, '--mode', 'plan', '--disable-slash-commands', '--print-timeout', '5m', '--output-format', 'stream-json', '--input-format', 'stream-json'];
  } else {
    const check = await authCheck(provider, command, env, options.signal);
    if (!check.authenticated) throw new ProviderError(check.message);
    args = provider === 'claude' ? [...CLAUDE_SAFE, ...CLAUDE_TASK] : codexArgs();
  }
  const input = provider === 'gemini' ? JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n' : prompt;
  const reply = await capture(command, args, env, { cwd: options.cwd, input, signal: options.signal, timeoutMs: TASK_TIMEOUT });
  if (reply.code !== 0 && unsupportedOptions(reply.stderr + '\n' + reply.stdout)) {
    throw new ProviderError(`Update ${NAMES[provider]} to its current official version. Connector’s required isolation options were rejected; the task was not retried with weaker permissions.`, 502);
  }
  if (reply.code !== 0) throw new ProviderError(`${NAMES[provider]} could not complete this task. Check its sign-in, subscription allowance, and installed version in the official app. Connector did not retry the request.`, 502);
  return { result: parseResult(provider, reply.stdout) };
}
