# Add a connector without resetting existing accounts

Each platform's adapter has a permanent provider ID. The encrypted credential, connection summary, and scheduled jobs are associated with that ID. New connectors extend the registry; they do not replace the saved database or regenerate the encryption or pipeline keys.

## Implementation checklist

1. Add a `ProviderAdapter` in a `server/providers-*.ts` module and register it in `server/providers.ts`. Choose a new, stable ID. Do not rename an existing ID to reuse it for a different service.
2. Implement the official authorization, verification, and refresh contracts in that adapter. Add the provider's application fields and setup link in `server/settings.ts` where needed. Merge settings using the existing settings service; never replace unrelated saved settings.
3. Register supported operations in `server/actions.ts` through an `ActionAdapter` module. Preserve existing provider/action IDs and scheduled-input compatibility. Additional scopes can require reauthorization of the affected platform; avoid invalidating unrelated connections.
4. Add provider documentation and contract tests that mock the official API. The dashboard and MCP tools discover registered providers and actions automatically.
5. Keep schema changes additive and backward compatible. Introduce an explicit data migration and backup strategy before a change that rewrites or removes existing data; the current update wizard replaces code and deliberately does not migrate credentials.
6. Increment the app version in `package.json` and the lockfile. Run tests and the Windows packaging workflow, including its real installation-upgrade smoke test, before distributing a new build.

The upgrade regression tests cover retained credential decryption, application settings, pending jobs, custom data locations, and recovery after a failed file replacement. Windows checks also validate native launcher/updater syntax, packaging, and installation of the extracted bundle.

Users install future code through **Update Connector**, selecting the installation they already use. Its `.env`, encryption key, pipeline key, SQLite files, and other private files remain in place. The updater rejects data paths that would be replaced as application code. Do not add private storage to the updater's managed-file list.

The Settings request form only prepares text for the user to copy to a developer. It does not submit a request externally, install arbitrary connectors, or create an API integration from a platform name alone.
