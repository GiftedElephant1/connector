# Obsidian notes

Connector lets your AI agent **read and write Markdown notes in one Obsidian vault folder on the PC running Connector**. It can list, search, read, create, append to, and edit notes. It cannot delete notes, read or write attachments, create folders, or change Obsidian settings.

Your Obsidian Sync subscription keeps your local vault connected to the cloud vault. Connector reads and writes that local copy; Obsidian picks up the changes and syncs them. Keep your PC and Connector running, and keep Obsidian open with Sync enabled to exchange changes with your other devices. Wait for Obsidian's Sync indicator to show that syncing has finished before asking about or editing a recently changed note. Connector cannot independently confirm that the local copy is current or that a new change has uploaded.

## Connect your vault without a command line

1. Open **Obsidian** on the same Windows PC where Connector runs.
2. Open the vault you want your AI agent to use. If it is not on this PC yet, open Obsidian's vault switcher and choose **Setup** under **Open vault from Obsidian Sync**. Sign in to your Obsidian account, select **Connect** beside your existing remote vault, enter its encryption password if requested, choose a name and location for the local vault, and select **Create**. Start syncing and wait for Obsidian's green checkmark. [Obsidian's setup guide](https://help.obsidian.md/sync/setup) explains the sync settings in detail.
3. In Obsidian's file explorer, right-click a note and choose **Show in system explorer**. File Explorer opens at that note's folder.
4. If the note is inside a subfolder, go up to the main vault folder. Choose the folder containing all the notes you want to share, not the `.obsidian` settings folder.
5. Click File Explorer's address bar. Copy the full folder path, such as `C:\Users\Alex\Documents\My vault`.
6. In Connector, find **Obsidian**, click **Connect account**, and paste that path into **Full path to your Obsidian vault folder**. Confirm the connection.
7. In your AI agent, ask: **“List my Obsidian notes,” “Search my Obsidian notes for project plans,” “Create Ideas.md with these ideas,”** or **“Read Projects/Plan.md, then append this update.”** Your agent uses the existing Connector connection. Confirm any write when your agent requests it.

You do not need an Obsidian API key, community plugin, account password, or Sync encryption password in Connector. The folder path is stored with the encrypted connection settings. Note contents are sent to the AI service when its agent requests them; connecting a vault authorizes that agent to read permitted Markdown notes and submit confirmed changes inside it.

To remove access, disconnect Obsidian in Connector. This does not delete the vault or disconnect Obsidian Sync. Your other connected services remain connected.

## Limits and protections

- Only `.md` files are available. Dotfiles and hidden configuration folders such as `.obsidian`, `.git`, and `.trash` are excluded. Windows file attributes alone do not define this exclusion: folders/files whose names start with a dot are excluded.
- Paths must remain inside the selected folder. Symbolic links, hard links, directory junctions, traversal, and alternate file streams are refused. Note links and embedded attachments are returned as Markdown text and are not followed. Writes require an existing parent folder.
- A note may be at most 1 MiB; each create, append, or edit request may contain at most 50,000 characters. Content must be nonempty UTF-8 Markdown. Leading/trailing whitespace and append newlines are preserved. Binary files mislabeled as Markdown are rejected.
- Lists scan at most 1,000 notes, 10,000 directory entries, and 32 path levels. List results support an `offset` and `limit` up to 100. Directory changes between requests may change the ordering.
- Searches use literal text, ignoring case, in note paths and contents. Each search reads up to 16 MiB and returns at most 100 matches. Any incomplete scan, unreadable/oversized note, or result limit is reported as a partial result. Narrow the selected folder if your vault exceeds these limits; partial results cannot establish that a note does not exist.
- A connected folder is a local resource. If Connector runs on another machine, a path on your PC is unavailable there. This version does not manage a separate cloud-hosted vault mirror.

## Creating and editing notes safely

`create-note` creates a new file and refuses to overwrite an existing path. For `append-note` or `update-note`, first call `read-note` and supply its returned SHA-256 `contentHash` as `expectedHash`. Connector refuses the change if the note has changed since that read. Append includes exactly the supplied text, so include any separating newline. Edit replaces the entire note; keep the content you intend to preserve in the replacement.

These are normal Connector write actions: they require explicit confirmation and a unique `requestId`. Reusing the same successful request returns its recorded result instead of writing twice. Read the note and review its contents before retrying an uncertain result with a new request ID.

Connector serializes its own writes to each note. It stages and flushes a complete temporary file in the same folder, rechecks the file identity and content hash, and then replaces the note atomically. Creation uses an exclusive operation, so a concurrently created file is never overwritten. A failure before replacement leaves the old note intact.

The version checks are **best effort against other applications**: Obsidian, Sync, or another editor can still change a file immediately after the final check because the filesystem does not offer a shared compare-and-swap operation. Let Sync finish and avoid editing the same note simultaneously on another device. No note deletion action is available.

## Official Obsidian services

Obsidian documents that [vaults are ordinary local Markdown folders](https://help.obsidian.md/data-storage), and that [Sync encrypts remote vaults, with end-to-end encryption enabled by default](https://help.obsidian.md/sync/security).

Obsidian also provides an official [Headless client](https://help.obsidian.md/headless) and [Headless Sync](https://help.obsidian.md/sync/headless) in open beta. They can synchronize a cloud vault to a separate computer without the desktop app. This is a supported upstream option, not a feature installed or managed by this Connector screen. **Obsidian explicitly warns against using desktop Sync and Headless Sync on the same device because it can cause data conflicts.** The PC setup above uses desktop Sync only.
