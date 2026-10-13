import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependency-free ZIP writer. Allowlisted source files only; never archive the workspace wholesale.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] ?? join(root, 'artifacts'));
const rootFiles = ['Start Connector.vbs', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', '.env.example', 'README.md'];
const directories = ['client', 'server', 'scripts', 'docs'];
const bannedNames = new Set(['node_modules', 'data', '.git', '.codex', '.agents', 'dist', 'artifacts']);
const files = [];

async function include(path) {
  const name = relative(root, path).split(sep).join('/');
  const basename = name.split('/').at(-1);
  if (name.split('/').some((part) => bannedNames.has(part))) return;
  if (name.split('/').some((part) => part.startsWith('.') && part !== '.env.example')) return;
  if (basename !== '.env.example' && (basename === '.env' || basename.startsWith('.env.'))) return;
  if (/\.(?:log|db|sqlite|sqlite3|pem|key|pfx|p12)(?:-|$)/i.test(basename)) return;
  files.push({ name: `Connector/${name}`, contents: await readFile(path) });
}

async function walk(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (bannedNames.has(entry.name) || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) await include(path);
  }
}

for (const file of rootFiles) await include(join(root, file));
for (const directory of directories) await walk(join(root, directory));

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
console.log(`Created ${destination} (${files.length} source files; dependencies install on first launch).`);
