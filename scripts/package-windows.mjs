import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { deflateRawSync } from 'node:zlib';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency-free ZIP writer. Allowlisted source files only; never archive the workspace wholesale.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let source, stage, destinationArgument, signed = false;
while (args.length) {
  const argument = args.shift();
  if (argument === '--signed') signed = true;
  else if (argument === '--source' || argument === '--stage') {
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a directory.`);
    if (argument === '--source') source = value;
    else stage = value;
  } else if (argument.startsWith('--') || destinationArgument) throw new Error(`Unexpected argument: ${argument}`);
  else destinationArgument = argument;
}
if (stage && (signed || destinationArgument)) throw new Error('--stage cannot be combined with an output directory or --signed.');
if (signed && !source) throw new Error('--signed requires the explicitly staged --source directory.');
const root = resolve(source ?? repository);
const output = resolve(destinationArgument ?? join(repository, 'artifacts'));
const rootFiles = ['Start Connector.vbs', 'Update Connector.vbs', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', '.env.example', 'README.md'];
const directories = ['client', 'server', 'scripts', 'docs'];
const bannedNames = new Set(['node_modules', 'data', '.git', '.codex', '.agents', 'dist', 'artifacts']);
const files = [];

async function include(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular package file: ${path}`);
  const name = relative(root, path).split(sep).join('/');
  const basename = name.split('/').at(-1);
  if (name.split('/').some((part) => bannedNames.has(part))) return;
  if (name.split('/').some((part) => part.startsWith('.') && part !== '.env.example')) return;
  if (basename !== '.env.example' && (basename === '.env' || basename.startsWith('.env.'))) return;
  if (/\.(?:log|db|sqlite|sqlite3|pem|key|pfx|p12)(?:-|$)/i.test(basename)) return;
  files.push({ name: `Connector/${name}`, contents: await readFile(path) });
}

async function walk(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new Error(`Expected a regular package directory: ${directory}`);
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (bannedNames.has(entry.name) || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) await include(path);
  }
}

for (const file of rootFiles) await include(join(root, file));
for (const directory of directories) await walk(join(root, directory));

if (stage) {
  // Create a fresh copy BEFORE signing. Never rewrite signed bytes when archiving.
  const stageRoot = resolve(stage);
  await mkdir(stageRoot); // Refuse to reuse a directory with stale signatures or data.
  for (const file of files) {
    const name = file.name.slice('Connector/'.length);
    let contents = file.contents;
    if (name === 'Start Connector.vbs' || name === 'Update Connector.vbs') {
      const text = contents.toString('utf8');
      if (!text.includes('-ExecutionPolicy Bypass -WindowStyle Hidden') || !text.includes('shell.Run(command, 0, False)')) {
        throw new Error(`Unexpected launcher format in ${name}; cannot prepare signed release.`);
      }
      contents = Buffer.from(text.replace('-ExecutionPolicy Bypass -WindowStyle Hidden', '-ExecutionPolicy AllSigned -WindowStyle Normal')
        .replace('result = shell.Run(command, 0, False)', 'command = command & " -HideLaunchConsole"\nresult = shell.Run(command, 1, False)'));
    }
    const target = join(stageRoot, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  console.log(`Prepared ${stageRoot} for publisher signing. This copy is not signed yet.`);
  process.exit(0);
}

if (signed) {
  if (process.platform !== 'win32') throw new Error('Signed releases require Windows Authenticode verification.');
  const verification = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    join(repository, 'scripts/windows-verify-signatures.ps1'), '-Path', root], { stdio: 'inherit' });
  if (verification.error) throw verification.error;
  if (verification.status !== 0) throw new Error('Publisher signature verification failed; no release ZIP was written.');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let result = index;
  for (let bit = 0; bit < 8; bit++) result = (result & 1) ? (0xedb88320 ^ (result >>> 1)) : (result >>> 1);
  return result >>> 0;
});
const crc32 = (data) => {
  let result = 0xffffffff;
  for (const byte of data) result = crcTable[(result ^ byte) & 0xff] ^ (result >>> 8);
  return (result ^ 0xffffffff) >>> 0;
};

const entries = [];
const centralDirectory = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file.name, 'utf8');
  const compressed = deflateRawSync(file.contents, { level: 9 });
  const checksum = crc32(file.contents);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6); // UTF-8 names.
  header.writeUInt16LE(8, 8); // DEFLATE.
  header.writeUInt16LE(0x0021, 12); // Stable ZIP date: January 1, 1980.
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(file.contents.length, 22);
  header.writeUInt16LE(name.length, 26);
  entries.push(header, name, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0x0021, 14);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(file.contents.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centralDirectory.push(central, name);
  offset += header.length + name.length + compressed.length;
}

const centralSize = centralDirectory.reduce((size, buffer) => size + buffer.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...entries, ...centralDirectory, end]);
await mkdir(output, { recursive: true });
const destination = join(output, 'Connector-Windows.zip');
await writeFile(destination, archive);
await writeFile(`${destination}.sha256`, `${createHash('sha256').update(archive).digest('hex')}  Connector-Windows.zip\n`);
console.log(`Created ${destination} (${files.length} ${signed ? 'publisher-verified' : 'unsigned development'} source files; dependencies install on first launch).`);
