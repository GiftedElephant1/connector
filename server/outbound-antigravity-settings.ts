import { constants } from 'node:fs';
import { lstat, open, opendir, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ProviderError } from './provider-types';

type Json = Record<string, unknown>;
type SettingsFile = 'antigravity-cli/settings.json' | 'config/config.json' | 'config/hooks.json' | 'config/mcp_config.json';
export interface AntigravitySettingsOptions { platform?: NodeJS.Platform }
const MAX_FILE_BYTES = 256 * 1024;
const object = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value);

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  return Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
}

/** Windows uses its user profile; a HOME inherited from Git Bash may differ. */
export function antigravityHome(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, fallback = homedir()): string {
  const home = envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform) || fallback;
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (!home || !paths.isAbsolute(home) || /[\0\r\n]/.test(home)) {
    throw new ProviderError('Antigravity’s user folder could not be located. Run Connector and Antigravity under the same operating-system account, then check readiness again.');
  }
  return home;
}

function label(relative: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? `%USERPROFILE%\\.gemini\\${relative.replaceAll('/', '\\')}` : `~/.gemini/${relative}`;
}

function settingsError(relative: string, platform: NodeJS.Platform, reason: string, recovery?: string): ProviderError {
  return new ProviderError(`Antigravity configuration (${label(relative, platform)}) ${reason}. ${recovery || 'Open Antigravity and resolve this file’s settings error, then check readiness again.'}`);
}

function ioError(error: unknown, relative: string, platform: NodeJS.Platform): ProviderError {
  const code = object(error) ? error.code : undefined;
  if (code === 'EACCES' || code === 'EPERM') {
    return settingsError(relative, platform, 'could not be read because access was denied', 'Run Connector and Antigravity under the same operating-system account and check this file’s permissions.');
  }
  if (code === 'ENOENT' || code === 'EBUSY' || code === 'EAGAIN' || code === 'ETXTBSY') {
    return settingsError(relative, platform, 'changed or was busy while Connector checked it', 'Finish saving settings in Antigravity, then check readiness again.');
  }
  return settingsError(relative, platform, 'could not be read', 'Check that the file is available to the operating-system account running Connector, then check readiness again.');
}

/**
 * Antigravity 1.1.24 explicitly supports comments and trailing commas in MCP
 * configuration. Use a string-aware scanner: URL strings, escaped quotes, and
 * comment-like text inside credentials must retain their exact JSON meaning.
 * This deliberately does not accept JSON5 syntax or use eval.
 */
function normalizeMcpJsonc(source: string): string {
  const chars = source.split('');
  let inString = false, escaped = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char !== '/' || !['/', '*'].includes(chars[index + 1])) continue;
    if (chars[index + 1] === '/') {
      while (index < chars.length && chars[index] !== '\n' && chars[index] !== '\r') chars[index++] = ' ';
      index--;
    } else {
      const start = index;
      index += 2;
      while (index < chars.length && !(chars[index] === '*' && chars[index + 1] === '/')) index++;
      if (index >= chars.length) throw new Error('Unclosed comment');
      index++;
      for (let cursor = start; cursor <= index; cursor++) if (!['\r', '\n'].includes(chars[cursor])) chars[cursor] = ' ';
    }
  }
  inString = false; escaped = false;
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char !== ',') continue;
    let after = index + 1, before = index - 1;
    while (after < chars.length && /\s/.test(chars[after])) after++;
    while (before >= 0 && /\s/.test(chars[before])) before--;
    // Preserve invalid {,}, [,], double commas, and missing values so JSON.parse
    // rejects them rather than converting a malformed security config to empty.
    if (['}', ']'].includes(chars[after]) && before >= 0 && !['{', '[', ',', ':'].includes(chars[before])) chars[index] = ' ';
  }
  return chars.join('');
}

/** Public configuration only. No auth caches or operating-system keyrings. */
async function readSettings(root: string, relative: SettingsFile, platform: NodeJS.Platform): Promise<Json | undefined> {
  const file = path.join(root, ...relative.split('/'));
  let info;
  try { info = await lstat(file); }
  catch (error) {
    if (object(error) && error.code === 'ENOENT') return undefined;
    throw ioError(error, relative, platform);
  }
  if (info.isSymbolicLink()) throw settingsError(relative, platform, 'is a linked file that Connector cannot validate in this mode', 'Use an Antigravity profile with a regular settings file; Connector has not changed the link or its target.');
  if (!info.isFile()) throw settingsError(relative, platform, 'is not a regular file');
  if (info.size > MAX_FILE_BYTES) throw settingsError(relative, platform, 'exceeds Connector’s 256 KiB settings-check limit', 'Review this configuration in Antigravity. If it is valid, share only this error message so Connector’s size limit can be reviewed.');
  let handle: FileHandle | undefined;
  let contents: Buffer;
  try {
    // NOFOLLOW prevents a link substituted between lstat and open on platforms
    // supporting it. Windows still gets the inode/type recheck below.
    handle = await open(file, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev) {
      throw settingsError(relative, platform, 'changed while Connector checked it', 'Finish saving settings in Antigravity, then check readiness again.');
    }
    // Bounded reads remain bounded even if another process grows the file after
    // the initial stat. Never load an unbounded file and check its size afterward.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_FILE_BYTES) throw settingsError(relative, platform, 'exceeds Connector’s 256 KiB settings-check limit', 'Review this configuration in Antigravity. If it is valid, share only this error message so Connector’s size limit can be reviewed.');
    contents = buffer.subarray(0, size);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw ioError(error, relative, platform);
  } finally { await handle?.close().catch(() => {}); }
  if ((contents[0] === 0xff && contents[1] === 0xfe) || (contents[0] === 0xfe && contents[1] === 0xff)) {
    throw settingsError(relative, platform, 'uses UTF-16 instead of UTF-8', 'Save this configuration as UTF-8 using Antigravity or a text editor, then check readiness again.');
  }
  // Official CLI changelog: config.json BOM support in 1.2.16, hooks/MCP/plugin
  // manifests in 1.3.1. A BOM is an encoding marker, never a settings value.
  if (contents[0] === 0xef && contents[1] === 0xbb && contents[2] === 0xbf) contents = contents.subarray(3);
  let source: string;
  try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contents); }
  catch { throw settingsError(relative, platform, 'contains invalid UTF-8 text', 'Save this configuration as UTF-8 using Antigravity or a text editor, then check readiness again.'); }
  let value: unknown;
  try { value = JSON.parse(relative === 'config/mcp_config.json' ? normalizeMcpJsonc(source) : source); }
  catch { throw settingsError(relative, platform, relative === 'config/mcp_config.json' ? 'contains malformed JSON or JSON comments' : 'contains malformed JSON'); }
  if (!object(value)) throw settingsError(relative, platform, 'must contain a JSON object, not an empty file, array, or null');
  return value;
}

async function present(root: string, relative: string, platform: NodeJS.Platform): Promise<boolean> {
  try { await lstat(path.join(root, ...relative.split('/'))); return true; }
  catch (error) { if (object(error) && error.code === 'ENOENT') return false; throw ioError(error, relative, platform); }
}

async function nonemptyDirectory(root: string, relative: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    const dir = await opendir(path.join(root, ...relative.split('/')));
    for await (const _entry of dir) return true;
    return false;
  } catch (error) { if (object(error) && error.code === 'ENOENT') return false; throw ioError(error, relative, platform); }
}

/** Fail closed on unreadable or active settings; never rewrite or delete them. */
export async function checkAntigravitySettings(env: NodeJS.ProcessEnv, options: AntigravitySettingsOptions = {}): Promise<void> {
  const platform = options.platform ?? process.platform;
  const root = path.join(antigravityHome(env, platform), '.gemini');
  const settings = await readSettings(root, 'antigravity-cli/settings.json', platform);
  if (settings?.modelProvider || settings?.useG1Credits === true) {
    throw new ProviderError('In Antigravity, select Google account sign-in and turn off Use AI Credits / AI Credit Overages before using subscription tasks.');
  }
  if (settings?.statusLine || settings?.title) {
    throw new ProviderError('Antigravity has a custom startup script. Use an Antigravity profile without custom scripts for Connector’s text tasks.');
  }
  const config = await readSettings(root, 'config/config.json', platform);
  if (object(config?.userSettings) && config.userSettings.enableAdc === true) {
    throw new ProviderError('Turn off Google Cloud ADC in Antigravity and sign in with your personal Google subscription account.');
  }
  for (const file of ['config/hooks.json', 'config/mcp_config.json'] as const) {
    const value = await readSettings(root, file, platform);
    if (value && Object.values(value).some(item => object(item) ? Object.keys(item).length > 0 : Array.isArray(item) ? item.length > 0 : Boolean(item))) {
      throw new ProviderError('Antigravity has global hooks or MCP servers. Use a clean Antigravity profile without those customizations for Connector’s isolated text tasks.');
    }
  }
  for (const dir of ['plugins', 'skills', 'rules']) {
    if (await nonemptyDirectory(root, `config/${dir}`, platform)) throw new ProviderError('Antigravity has global plugins, skills, or rules. Use a clean Antigravity profile for Connector’s isolated text tasks.');
  }
  if (await present(root, 'GEMINI.md', platform)) throw new ProviderError('Antigravity has global instructions. Use a clean Antigravity profile for Connector’s isolated text tasks.');
}
