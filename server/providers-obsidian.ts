import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { ProviderError, type Credential, type ProviderAdapter } from './provider-types';

/** The owner selects a local vault. No Obsidian passwords or cloud session tokens are needed. */
export async function obsidianVaultRoot(credential: Credential): Promise<string> {
  const path = credential.fields?.vaultPath?.trim();
  if (!path || path.includes('\0') || !isAbsolute(path)) {
    throw new ProviderError('Choose the full path to the Obsidian vault folder on the computer running Connector.');
  }
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('invalid vault');
    const root = await realpath(path);
    // Checking that the directory can be opened catches missing permissions during connection.
    const directory = await opendir(root);
    await directory.close();
    return root;
  } catch {
    throw new ProviderError('The vault folder is unavailable. Choose an existing folder, not a shortcut or symbolic link, that Connector can read.');
  }
}

export const obsidianAdapters: ProviderAdapter[] = [{
  definition: {
    id: 'obsidian', name: 'Obsidian', category: 'websites', authType: 'local',
    description: 'Let your AI agents read, create, append to, and edit Markdown notes in a local Obsidian vault. Obsidian Sync connects this folder to your cloud vault; wait for sync to finish before working with recent changes.',
    docsUrl: 'https://help.obsidian.md/data-storage',
    credentialFields: [{ name: 'vaultPath', label: 'Full path to your Obsidian vault folder', secret: false }],
  },
  requiredEnv: [],
  verify: async (credential) => {
    const root = await obsidianVaultRoot(credential);
    const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
    return {
      accountId: id,
      accountName: basename(root) || 'Obsidian vault',
      resources: [{ id, name: 'Read, create, append to, and edit Markdown notes in the selected folder', type: 'vault' }],
    };
  },
}];
