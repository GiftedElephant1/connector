import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { ProviderError } from './provider-types';
import type { OnePasswordAccount, OnePasswordCheck, OnePasswordField, OnePasswordItem, OnePasswordSelection, OnePasswordVault } from './onepassword-types';

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const APPROVAL_TIMEOUT_MS = 90_000;
const OBJECT_ID = /^[a-z0-9]{26}$/i;
const FIELD_SELECTION = /^f_[A-Za-z0-9_-]{4,4096}$/;
const READ_ERROR = '1Password could not complete this request. Unlock the 1Password desktop app, enable Settings → Developer → Integrate with 1Password CLI, and approve Connector’s request.';
const MISSING_ERROR = '1Password CLI was not found. Install the official 1Password CLI, restart Connector, or select the full path to op.exe (Windows) or op (macOS/Linux).';
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value);

export interface OnePasswordRunOptions { env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }
export type OnePasswordRunner = (executable: string, args: string[], options: OnePasswordRunOptions) => Promise<string>;
class CliFailure extends Error {
  constructor(public readonly kind: 'missing' | 'timeout' | 'output' | 'failed') { super(kind); }
}

/** Pass only OS desktop/keyring essentials, never Connector or automation secrets. */
export function onePasswordEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
    'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'PATH', 'PATHEXT', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined && allowed.has(key.toUpperCase())) env[key] = value;
  env.NO_COLOR = '1';
  env.TERM = 'dumb';
  env.OP_BIOMETRIC_UNLOCK_ENABLED = 'true';
  env.OP_DEBUG = 'false';
  env.OP_INCLUDE_ARCHIVE = 'false';
  return env;
}

/** Fixed native locations only; no cwd lookup or shell-based executable discovery. */
export function onePasswordExecutableCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const envValue = (name: string) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1] || '';
  const local = (directory: string) => paths.isAbsolute(directory) && !directory.startsWith('\\\\') && !directory.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(directory);
  const directories = envValue('PATH').split(platform === 'win32' ? ';' : ':').filter(local);
  const appData = envValue('LOCALAPPDATA');
  // WinGet may install while Connector is running, before its PATH is refreshed.
  if (platform === 'win32' && local(appData)) directories.push(paths.join(appData, 'Microsoft', 'WinGet', 'Links'));
  return [...new Set(directories.map(directory => paths.join(directory, platform === 'win32' ? 'op.exe' : 'op')))];
}

/** The child is launched directly by the stable Connector process for desktop approval. */
export const runOnePassword: OnePasswordRunner = (executable, args, options) => new Promise((resolve, reject) => {
  const child = execFile(executable, args, {
    env: options.env, cwd: homedir(), shell: false, windowsHide: true, encoding: 'utf8',
    timeout: options.timeoutMs, maxBuffer: options.maxOutputBytes, killSignal: 'SIGKILL',
  }, (error, stdout) => {
    // ChildProcess errors and stderr may contain sensitive output. Never pass them on.
    if (error) {
      const code = 'code' in error ? error.code : undefined;
      return reject(new CliFailure(code === 'ENOENT' ? 'missing' : code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output' : error.killed ? 'timeout' : 'failed'));
    }
    resolve(stdout);
  });
  // Authentication belongs to 1Password's desktop approval, never a hidden
  // master-password prompt or credentials written to subprocess stdin.
  child.stdin?.end();
});

function safeFailure(error: unknown): ProviderError {
  if (error instanceof CliFailure) {
    if (error.kind === 'missing') return new ProviderError(MISSING_ERROR, 503);
    if (error.kind === 'timeout') return new ProviderError('The 1Password request timed out. Unlock 1Password and approve the desktop request, then try again.', 504);
    if (error.kind === 'output') return new ProviderError('The 1Password response was too large. Select a smaller vault or item.', 413);
  }
  return new ProviderError(READ_ERROR, 503);
}
function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new ProviderError(`Choose a valid 1Password ${label} from the list.`);
  return value;
}
function text(value: unknown, fallback: string, max = 300): string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : fallback;
}
function rows(value: unknown, limit: number): JsonObject[] {
  if (!Array.isArray(value) || value.length > limit || value.some(row => !object(row))) throw new ProviderError('1Password returned unsupported or oversized metadata. Update the CLI or choose a smaller vault.', 502);
  return value as JsonObject[];
}
function validFieldPart(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
}
function fieldId(field: JsonObject): string {
  if (!validFieldPart(field.id) || (field.section !== undefined && (!object(field.section) || !validFieldPart(field.section.id)))) {
    throw new ProviderError('1Password returned an unsupported field identifier.', 502);
  }
  // Section IDs may contain spaces; built-in field IDs can repeat in sections.
  // Encode the pair rather than trusting references, labels, or path fragments.
  const section = object(field.section) ? field.section.id as string : '';
  return `f_${Buffer.from(JSON.stringify([section, field.id]), 'utf8').toString('base64url')}`;
}

export class OnePasswordCli {
  private readonly run: OnePasswordRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly customRunner: boolean;
  constructor(options: { run?: OnePasswordRunner; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) {
    this.run = options.run || runOnePassword;
    this.env = onePasswordEnvironment(options.env);
    this.platform = options.platform || process.platform;
    this.customRunner = !!options.run;
  }
  private executableValue(value: string): string {
    if (typeof value !== 'string') throw new ProviderError('Choose the full path to the official 1Password CLI executable, without arguments.');
    const selected = value || 'op';
    if (typeof selected !== 'string' || selected.length > 2048 || /[\u0000-\u001f\u007f]/.test(selected)) throw new ProviderError('Choose the full path to the official 1Password CLI executable, without arguments.');
    if (selected === 'op' || (this.platform === 'win32' && selected === 'op.exe')) return selected;
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    if (!paths.isAbsolute(selected) || selected.startsWith('\\\\') || selected.startsWith('//') || paths.basename(selected).toLowerCase() !== (this.platform === 'win32' ? 'op.exe' : 'op')) {
      throw new ProviderError('Choose the full local path to op.exe (Windows) or op (macOS/Linux). Shell commands and scripts are not supported.');
    }
    return selected;
  }
  private async executable(value: string): Promise<string> {
    const selected = this.executableValue(value);
    if (this.customRunner) return selected;
    const paths = this.platform === 'win32' ? path.win32 : path.posix;
    if (paths.isAbsolute(selected)) return selected;
    // Avoid cwd-relative PATH entries and Windows' implicit current-directory search.
    for (const candidate of onePasswordExecutableCandidates(this.env, this.platform)) {
      try {
        if (!(await stat(candidate)).isFile()) continue;
        await access(candidate, this.platform === 'win32' ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch { /* Try the next fixed executable location. */ }
    }
    throw new CliFailure('missing');
  }
  private async capture(executable: string, args: string[], timeoutMs = APPROVAL_TIMEOUT_MS): Promise<string> {
    // Validate caller input outside the catch; only fixed CLI error text is surfaced.
    this.executableValue(executable);
    try {
      const output = await this.run(await this.executable(executable), args, { env: { ...this.env }, timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES });
      if (typeof output !== 'string' || Buffer.byteLength(output, 'utf8') > MAX_OUTPUT_BYTES) throw new CliFailure('output');
      return output;
    } catch (error) { throw safeFailure(error); }
  }
  private async json(executable: string, args: string[]): Promise<unknown> {
    const output = await this.capture(executable, [...args, '--format=json']);
    try { return JSON.parse(output); }
    catch { throw new ProviderError('1Password returned an unsupported response. Update the official CLI and try again.', 502); }
  }
  async check(executable: string): Promise<OnePasswordCheck> {
    try {
      const version = (await this.capture(executable, ['--version'], 10_000)).trim();
      if (!/^2\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(version)) return { installed: false, message: 'Install a supported 1Password CLI version 2. The installed command did not report a supported version.' };
      return { installed: true, version, message: '1Password CLI is installed. Unlock the desktop app and enable Integrate with 1Password CLI, then load accounts and approve access when prompted.' };
    } catch (error) {
      return { installed: false, message: error instanceof ProviderError ? error.message : READ_ERROR };
    }
  }
  async accounts(executable: string): Promise<OnePasswordAccount[]> {
    const entries = rows(await this.json(executable, ['account', 'list']), 100);
    return entries.map(row => ({ id: identifier(row.account_uuid, 'account'), name: text(row.name, text(row.email, text(row.url, '1Password account'))) }));
  }
  async vaults(executable: string, accountId: string): Promise<OnePasswordVault[]> {
    const entries = rows(await this.json(executable, ['vault', 'list', '--account', identifier(accountId, 'account')]), 500);
    return entries.map(row => ({ id: identifier(row.id, 'vault'), name: text(row.name, '1Password vault') }));
  }
  async items(executable: string, accountId: string, vaultId: string): Promise<OnePasswordItem[]> {
    const entries = rows(await this.json(executable, ['item', 'list', '--account', identifier(accountId, 'account'), '--vault', identifier(vaultId, 'vault')]), 5000);
    return entries.map(row => ({ id: identifier(row.id, 'item'), title: text(row.title, '1Password item'), category: text(row.category, 'UNKNOWN', 80) }));
  }
  private async item(executable: string, selection: OnePasswordSelection): Promise<JsonObject[]> {
    const accountId = identifier(selection.accountId, 'account');
    const vaultId = identifier(selection.vaultId, 'vault');
    const itemId = identifier(selection.itemId, 'item');
    const result = await this.json(executable, ['item', 'get', itemId, '--account', accountId, '--vault', vaultId]);
    if (!object(result) || result.id !== itemId || !object(result.vault) || result.vault.id !== vaultId) throw new ProviderError('1Password returned a different item. Select the intended item again.', 502);
    const fields = rows(result.fields, 500);
    const ids = fields.map(fieldId);
    if (new Set(ids).size !== ids.length) throw new ProviderError('1Password returned ambiguous item fields. Choose an item with unique field identifiers.', 502);
    return fields;
  }
  async fields(executable: string, selection: OnePasswordSelection): Promise<OnePasswordField[]> {
    const fields = await this.item(executable, selection);
    return fields.map(field => {
      const section = object(field.section) ? text(field.section.label, '') : '';
      const label = text(field.label, text(field.id, 'Field'));
      return { id: fieldId(field), label: section ? `${section} / ${label}` : label, type: text(field.type, 'UNKNOWN', 80),
        ...(typeof field.purpose === 'string' && /^[A-Z_]{1,50}$/.test(field.purpose) ? { purpose: field.purpose } : {}) };
    });
  }
  async readFields(executable: string, selection: OnePasswordSelection, fieldIds: string[], visibleFieldIds: string[] = []): Promise<Record<string, string>> {
    if (!Array.isArray(fieldIds) || fieldIds.length < 1 || fieldIds.length > 50 || fieldIds.some(id => typeof id !== 'string' || !FIELD_SELECTION.test(id))) throw new ProviderError('Choose the 1Password fields to use.');
    if (!Array.isArray(visibleFieldIds) || visibleFieldIds.length > 50 || visibleFieldIds.some(id => typeof id !== 'string' || !fieldIds.includes(id))) throw new ProviderError('Choose valid 1Password fields for visible connection settings.');
    const fields = await this.item(executable, selection);
    const values: Record<string, string> = {};
    for (const id of new Set(fieldIds)) {
      const field = fields.find(entry => fieldId(entry) === id);
      if (!field || typeof field.value !== 'string' || !field.value || field.value.length > 8192 || /[\u0000\r\n]/.test(field.value)) {
        throw new ProviderError('An approved 1Password field is missing, empty, or not a supported single-line credential. Review the linked item.', 422);
      }
      // Recheck secrecy on the same item snapshot as the resolved value: a field
      // can become concealed after the owner originally saved the link.
      if (visibleFieldIds.includes(id) && (String(field.type).toUpperCase() === 'CONCEALED' || String(field.purpose).toUpperCase() === 'PASSWORD')) {
        throw new ProviderError('A concealed 1Password field cannot be used for a visible connection setting. Review the linked item and field mapping.', 422);
      }
      values[id] = field.value;
    }
    return values;
  }
}
