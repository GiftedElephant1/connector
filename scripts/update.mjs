import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

// The update package contains code only. Private configuration and account storage
// always stay in the original installation, even while an update is rolled back.
export const rootFiles = ['Start Connector.vbs', 'Update Connector.vbs', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', '.env.example', 'README.md'];
const sourceDirectories = ['client', 'server', 'scripts', 'docs'];
const managedNames = [...rootFiles, ...sourceDirectories, 'node_modules', 'dist'];
const transactionName = '.connector-update';
const activeTransactions = new Set();
const excludedNames = new Set(['node_modules', 'data', 'dist', 'artifacts']);
const messages = {
  UNSAFE_PATH: 'Choose separate, fully extracted Connector folders without symbolic links or junctions.',
  INVALID_INSTALLATION: 'Choose your existing Connector folder, containing Start Connector and its saved configuration.',
  INVALID_BUNDLE: 'Download and fully extract a complete Connector update before trying again.',
  INVALID_CONFIGURATION: 'The existing private configuration is incomplete. Restore its original .env file and encryption key before updating.',
  UNSAFE_DATA_DIRECTORY: 'The configured account storage overlaps application files. Move that storage before updating.',
  DOWNGRADE: 'This download is older than the installed Connector. Download the latest version.',
  PREPARATION_FAILED: 'The update could not be installed or built. Check your connection and disk space. The installed app was not changed.',
  UPDATE_FAILED: 'The update could not be applied. The previous application files have been restored.',
  RECOVERY_REQUIRED: 'The interrupted update could not be restored. Keep both folders and retry Update Connector after closing the app.',
  UPDATE_BUSY: 'Another Connector update is still running. Wait for that update to finish.',
};

export class UpdateError extends Error {
  constructor(code) { super(messages[code]); this.code = code; }
}
const fail = code => { throw new UpdateError(code); };
const exists = async path => { try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const inside = (parent, child) => { const path = relative(parent, child); return !path || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path)); };
const overlaps = (a, b) => inside(a, b) || inside(b, a);

// Check ancestors as well as the final entry: Windows junctions are reported as
// symbolic links by lstat. Missing leaf paths are permitted for new data folders.
async function noLinks(path) {
  let current = resolve(path);
  while (true) {
    const info = await exists(current);
    if (info?.isSymbolicLink()) fail('UNSAFE_PATH');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function directory(path, code = 'UNSAFE_PATH') {
  await noLinks(path);
  if (!(await exists(path))?.isDirectory()) fail(code);
  return realpath(path);
}

async function canonicalDataPath(path) {
  await noLinks(path);
  // Resolve existing ancestors too: a missing data leaf can be reached through
  // Windows 8.3 short names that otherwise evade lexical overlap checks.
  const missing = [];
  let ancestor = path;
  while (!(await exists(ancestor))) {
    missing.unshift(basename(ancestor));
    ancestor = dirname(ancestor);
  }
  return resolve(await realpath(ancestor), ...missing);
}

function version(value, code) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) fail(code);
  return value.split('.').map(Number);
}

async function packageInfo(root, code) {
  try {
    await noLinks(join(root, 'package.json'));
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'connector' || pkg.private !== true) fail(code);
    version(pkg.version, code);
    return pkg;
  } catch (error) { if (error instanceof UpdateError) throw error; fail(code); }
}

async function configuration(target) {
  await noLinks(join(target, '.env'));
  let env;
  try { env = parseEnv(await readFile(join(target, '.env'), 'utf8')); } catch { fail('INVALID_CONFIGURATION'); }
  if (!/^[a-f0-9]{64}$/i.test(env.ENCRYPTION_KEY || '') || (env.APP_PASSWORD || '').length < 12) fail('INVALID_CONFIGURATION');
  const dataDirectory = await canonicalDataPath(resolve(target, env.DATA_DIR || './data'));
  // dotenv preserves inherited variables, so protect an inherited DATA_DIR too.
  const dataDirectories = [dataDirectory, ...(process.env.DATA_DIR ? [await canonicalDataPath(resolve(target, process.env.DATA_DIR))] : [])];
  for (const path of dataDirectories) {
    await noLinks(path);
    if ([...managedNames, transactionName].some(name => overlaps(path, join(target, name)))) fail('UNSAFE_DATA_DIRECTORY');
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fail('INVALID_CONFIGURATION');
  return { dataDirectory, dataDirectories, port };
}

async function journalAt(target) {
  const transaction = join(target, transactionName);
  if (!(await exists(transaction))) return null;
  await directory(transaction);
  await noLinks(join(transaction, 'journal.json'));
  let journal;
  try { journal = JSON.parse(await readFile(join(transaction, 'journal.json'), 'utf8')); }
  catch {
    // A crash between mkdir and the first journal rename has not touched code.
    const contents = await readdir(transaction);
    if (contents.every(name => name === 'journal.next')) {
      // Another process may be between mkdir and the first journal write.
      if (Date.now() - (await lstat(transaction)).mtimeMs < 60_000) fail('UPDATE_BUSY');
      const pkg = await packageInfo(target, 'RECOVERY_REQUIRED');
      return { format: 1, target, phase: 'preparing', currentVersion: pkg.version, entries: [], ownerPid: 0 };
    }
    fail('RECOVERY_REQUIRED');
  }
  if (journal.format !== 1 || journal.target !== target || !['preparing', 'applying', 'committed'].includes(journal.phase)
    || !Array.isArray(journal.entries) || new Set(journal.entries.map(entry => entry.name)).size !== journal.entries.length
    || journal.entries.some(entry => !managedNames.includes(entry.name) || typeof entry.previous !== 'boolean')
    || (journal.phase !== 'preparing' && journal.entries.length !== managedNames.length)
    || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid < 1) fail('RECOVERY_REQUIRED');
  version(journal.currentVersion, 'RECOVERY_REQUIRED');
  return journal;
}

function checkOwner(journal, target, allowActive = false) {
  if (!journal?.ownerPid || allowActive) return;
  if (journal.ownerPid === process.pid && !activeTransactions.has(target)) return;
  try { process.kill(journal.ownerPid, 0); } catch (error) { if (error.code === 'ESRCH') return; }
  fail('UPDATE_BUSY');
}

async function saveJournal(transaction, journal) {
  // A durable file followed by rename leaves either the old or new complete
  // journal after interruption; no credentials are ever written here.
  const temporary = join(transaction, 'journal.next');
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(journal)); await file.sync(); } finally { await file.close(); }
  await rename(temporary, join(transaction, 'journal.json'));
}

function allowedSourceName(name) {
  return !excludedNames.has(name) && !name.startsWith('.') && !/\.(?:log|db|sqlite|sqlite3|pem|key|pfx|p12)(?:-|$)/i.test(name);
}

async function copyDirectory(source, destination) {
  await directory(source, 'INVALID_BUNDLE');
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) fail('UNSAFE_PATH');
    if (!allowedSourceName(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to, constants.COPYFILE_EXCL);
    else fail('INVALID_BUNDLE');
  }
}

export async function validateUpdate({ source, target }) {
  source = await directory(resolve(source), 'INVALID_BUNDLE');
  target = await directory(resolve(target), 'INVALID_INSTALLATION');
  if (overlaps(source, target)) fail('UNSAFE_PATH');
  const config = await configuration(target);
  if (config.dataDirectories.some(path => overlaps(source, path))) fail('UNSAFE_DATA_DIRECTORY');
  const pending = await journalAt(target);
  checkOwner(pending, target);
  const installed = pending?.phase === 'applying' ? { version: pending.currentVersion } : await packageInfo(target, 'INVALID_INSTALLATION');
  const incoming = await packageInfo(source, 'INVALID_BUNDLE');
  const oldVersion = version(installed.version, 'INVALID_INSTALLATION');
  const newVersion = version(incoming.version, 'INVALID_BUNDLE');
  for (let i = 0; i < 3; i++) {
    if (newVersion[i] < oldVersion[i]) fail('DOWNGRADE');
    if (newVersion[i] > oldVersion[i]) break;
  }
  for (const name of managedNames) {
    await noLinks(join(target, name));
    if (name !== 'node_modules' && name !== 'dist') await noLinks(join(source, name));
  }
  for (const name of ['Start Connector.vbs', 'package-lock.json', 'scripts/windows-launcher.ps1', 'server/index.ts']) {
    if (!pending && !(await exists(join(target, name)))?.isFile()) fail('INVALID_INSTALLATION');
    if (!(await exists(join(source, name)))?.isFile()) fail('INVALID_BUNDLE');
  }
  for (const name of rootFiles) if (!(await exists(join(source, name)))?.isFile()) fail('INVALID_BUNDLE');
  for (const name of sourceDirectories) await directory(join(source, name), 'INVALID_BUNDLE');
  return { source, target, currentVersion: installed.version, newVersion: incoming.version, dataDirectory: config.dataDirectory, port: config.port, pendingRecovery: !!pending };
}

export async function recoverInstallation(target, onProgress = () => {}, allowActive = false) {
  target = await directory(resolve(target), 'INVALID_INSTALLATION');
  await configuration(target);
  const journal = await journalAt(target);
  if (!journal) return false;
  checkOwner(journal, target, allowActive);
  const transaction = join(target, transactionName);
  onProgress('recovering');
  try {
    if (journal.phase === 'applying') {
      const backup = join(transaction, 'backup');
      await directory(backup);
      for (const entry of [...journal.entries].reverse()) {
        const destination = join(target, entry.name);
        const original = join(backup, entry.name);
        await noLinks(destination);
        await noLinks(original);
        if (await exists(original)) {
          await rm(destination, { recursive: true, force: true });
          await rename(original, destination);
        } else if (!entry.previous) await rm(destination, { recursive: true, force: true });
      }
    }
    await rm(transaction, { recursive: true, force: true });
    return true;
  } catch { fail('RECOVERY_REQUIRED'); }
}

async function runNpm(stage, npmCli, arguments_) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [npmCli, ...arguments_], {
      cwd: stage, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH || ''}` },
    });
    child.once('error', () => reject(new UpdateError('PREPARATION_FAILED')));
    child.once('exit', code => code === 0 ? accept() : reject(new UpdateError('PREPARATION_FAILED')));
  });
}

async function prepareApplication(stage, onProgress, npmCli) {
  const candidates = [npmCli, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), process.env.npm_execpath, resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  let selected;
  for (const candidate of candidates) if ((await exists(candidate))?.isFile()) { selected = candidate; break; }
  if (!selected) fail('PREPARATION_FAILED');
  onProgress('installing');
  await runNpm(stage, selected, ['ci', '--no-audit', '--no-fund']);
  onProgress('building');
  await runNpm(stage, selected, ['run', 'build']);
}

export async function updateInstallation({ source, target, prepare, beforeReplace = () => {}, onProgress = () => {}, npmCli }) {
  let information = await validateUpdate({ source, target });
  if (information.pendingRecovery) {
    await recoverInstallation(information.target, onProgress);
    information = await validateUpdate({ source, target });
  }
  source = information.source;
  target = information.target;
  const transaction = join(target, transactionName);
  await mkdir(transaction, { mode: 0o700 });
  activeTransactions.add(target);
  const stage = join(transaction, 'stage');
  const backup = join(transaction, 'backup');
  const journal = { format: 1, target, ownerPid: process.pid, phase: 'preparing', currentVersion: information.currentVersion, entries: [] };
  let applying = false;
  try {
    await saveJournal(transaction, journal);
    await mkdir(stage);
    await mkdir(backup);
    onProgress('preparing');
    for (const name of rootFiles) await copyFile(join(source, name), join(stage, name), constants.COPYFILE_EXCL);
    for (const name of sourceDirectories) await copyDirectory(join(source, name), join(stage, name));
    await (prepare ? prepare(stage) : prepareApplication(stage, onProgress, npmCli));
    await directory(join(stage, 'node_modules'), 'PREPARATION_FAILED');
    await directory(join(stage, 'dist'), 'PREPARATION_FAILED');
    if (!(await exists(join(stage, 'dist/index.html')))?.isFile()) fail('PREPARATION_FAILED');
    // Recheck the private paths immediately before applying. No setup script is
    // run, and no existing environment, key, database, or storage is copied.
    await configuration(target);
    for (const name of managedNames) {
      await noLinks(join(target, name));
      journal.entries.push({ name, previous: !!(await exists(join(target, name))) });
    }
    journal.phase = 'applying';
    await saveJournal(transaction, journal);
    applying = true;
    onProgress('applying');
    for (const [index, entry] of journal.entries.entries()) {
      await beforeReplace(entry.name, index);
      if (entry.previous) await rename(join(target, entry.name), join(backup, entry.name));
      await rename(join(stage, entry.name), join(target, entry.name));
    }
    journal.phase = 'committed';
    await saveJournal(transaction, journal);
  } catch (error) {
    if (applying) {
      onProgress('rolling-back');
      await recoverInstallation(target, onProgress, true);
      fail('UPDATE_FAILED');
    }
    await rm(transaction, { recursive: true, force: true });
    if (error instanceof UpdateError) throw error;
    fail('PREPARATION_FAILED');
  } finally {
    activeTransactions.delete(target);
  }
  // Cleanup failure after a committed update is harmless: next invocation
  // discards this completed journal, without reverting a successful update.
  await rm(transaction, { recursive: true, force: true }).catch(() => {});
  return information;
}

async function main() {
  const arguments_ = process.argv.slice(2);
  let target, npmCli;
  let checkOnly = false, recoverOnly = false;
  for (let i = 0; i < arguments_.length; i++) {
    if (arguments_[i] === '--target') target = arguments_[++i];
    else if (arguments_[i] === '--npm-cli') npmCli = arguments_[++i];
    else if (arguments_[i] === '--check-only') checkOnly = true;
    else if (arguments_[i] === '--recover-only') recoverOnly = true;
    else fail('INVALID_INSTALLATION');
  }
  if (!target || (checkOnly && recoverOnly)) fail('INVALID_INSTALLATION');
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const onProgress = code => console.log(JSON.stringify({ event: 'progress', code, stage: code }));
  if (recoverOnly) {
    await recoverInstallation(target, onProgress);
    console.log(JSON.stringify({ event: 'complete', stage: 'complete' }));
  } else if (checkOnly) console.log(JSON.stringify(await validateUpdate({ source, target })));
  else {
    const result = await updateInstallation({ source, target, npmCli, onProgress });
    console.log(JSON.stringify({ event: 'complete', stage: 'complete', currentVersion: result.currentVersion, newVersion: result.newVersion }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const safe = error instanceof UpdateError ? error : new UpdateError('RECOVERY_REQUIRED');
    console.error(JSON.stringify({ event: 'error', error: safe.code, code: safe.code, message: safe.message }));
    process.exitCode = 1;
  });
}
