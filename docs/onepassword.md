# Use credentials from 1Password

Connector supports two workflows in **Settings → 1Password**. For website sign-in, **Browser access for AI agents** retrieves live matching logins across all accessible vaults without individual links. See [the local browser guide](local-browser.md). For a supported Connector API destination, choose an item and field mapping once, then use its saved credential link to retrieve and apply the current values.

Only the Connector owner can browse 1Password in Settings and create links. An AI may use a saved link only when the owner has granted that AI access to that link. The AI receives a status result, never the retrieved secret values. Links do not give an AI permission to browse the vault or choose arbitrary destinations. The separate browser permission allows matching website logins across accessible vaults and use of the resulting local browser session.

## Set up the Connector PC

1Password must be available on the computer running Connector, under the same operating-system user. Installing it on an AI's cloud computer does not connect it to your PC's vault.

### Windows

1. In your extracted Connector folder, open **Setup 1Password** (`Setup 1Password.vbs`). This helper is included in the Windows ZIP and account-preserving updates.
2. If needed, choose **Get 1Password desktop**, install the official desktop app, and sign in inside 1Password.
3. Choose **Install 1Password CLI** if the helper reports that it is missing. The helper uses Windows Package Manager to install the exact official `AgileBits.1Password.CLI` package for your Windows user. If Windows Package Manager is unavailable, choose **Official CLI setup guide** and follow the official installation instructions.
4. In the 1Password app, enable **Windows Hello**. Choose **Open 1Password settings** in the helper, or open **Settings → Developer** inside 1Password, then enable **Integrate with 1Password CLI**.
5. Restart Connector if it was already running when you installed the CLI. Open Connector's **Settings → 1Password**, select **Enable 1Password credential retrieval**, then click **Save 1Password setup**, **Check 1Password CLI**, and **Load 1Password accounts**. Unlock 1Password and approve its Windows Hello prompt when asked.

The setup helper never asks for your account password, Secret Key, or vault contents. It does not change vault items, Connector's `.env`, or another AI application's MCP configuration. Closing it during a CLI installation leaves Windows Package Manager running; reopen the helper and choose **Check again** when installation finishes.

If you prefer the official PowerShell installation command:

```powershell
winget install --id AgileBits.1Password.CLI --exact --source winget
```

The desktop app and CLI must both run as the Windows user running Connector. Keep 1Password available in the notification area. If your organization controls developer integration, its administrator may need to enable it.

### macOS and Linux

Install the desktop app and CLI using [1Password's official instructions](https://www.1password.dev/cli/get-started). Enable **Settings → Developer → Integrate with 1Password CLI**. Linux additionally requires the documented system-authentication/PolKit setup. Restart Connector after installing the executable so it can find `op`.

## Create a credential link

1. Open **Settings → 1Password**, select **Enable 1Password credential retrieval**, and click **Save 1Password setup**. Click **Check 1Password CLI**, then **Load 1Password accounts**.
2. Under **Link a credential**, select the **1Password account**, **1Password vault**, and **1Password item** containing the intended credential. Connector shows item and field names to help you choose; it does not display field values.
3. Select **Connector destination**. Under **Choose the saved fields**, map each required destination field to its corresponding field in that 1Password item. For example, map a provider's API key to the item's API-key field, or map a supported username/application-password connection to its corresponding login fields. Enter any requested non-secret destination information, such as a WordPress site URL, directly in its labeled field.
4. Enter a recognizable **Credential link name** and click **Save credential link**. Review **AI connections allowed to use this credential**; new links grant no AI access by default.
5. Choose **Use now** to retrieve the selected fields and apply them to that destination. Approve 1Password's local authentication prompt if it appears.
6. Check the returned status, then verify the destination's actual account identity or readiness through its normal Connector controls before requesting work.

Use the credential type required by the destination. A website password does not substitute for an API key or an application password. Importing OAuth application credentials prepares the application settings; the account owner must still complete the provider's official sign-in and consent. 1Password does not bypass MFA, account eligibility, or required OAuth approval.

A saved link records the chosen account/item/field references and destination. **Use now** retrieves the current selected values and passes them to Connector's existing encrypted credential storage. Subsequent platform calls use those saved credentials. This is not continuous synchronization: after rotating a credential in 1Password, use the link again to apply the replacement.

Supported destinations are listed live in **Connector destination**:

| Destination | What applying a link does |
| --- | --- |
| Supported API-key or application-password platform connection | Retrieves the mapped credentials, verifies them with the provider, and saves the connected account. |
| Provider or Google Workspace application settings | Owner only: saves the selected application IDs/secrets. Complete official account sign-in separately. Non-secret client IDs remain visible in normal application settings. |
| Cursor task sending API key | Saves the Cursor account key. Select an eligible model and enable task sending separately. |
| Grok Bot routine credentials | Saves the mapped webhook URL/key. It does not enable task sending or trigger the routine. |
| Google Maps key for a connected Google account | Saves that account's Maps project key. Existing Google Workspace app permissions still apply. |
| ngrok public access authtoken | Owner only: saves the authtoken for the next public-access start. It does not restart the tunnel or change the public address. |

The link's AI access controls who may retrieve and apply the credential. The resulting connection follows Connector's existing account/tool permissions, so it can be available to other clients already authorized for those platform tools.

## Let an AI use an approved link

In **Settings → 1Password → Saved credential links**, choose **Edit link**, select the intended callers under **AI connections allowed to use this credential**, then click **Save link changes**. Some destinations are owner-only and cannot be assigned to an AI. An AI cannot grant itself access, edit the field mapping, or use the link for another destination. A general Connector key can be shared by several Bots, so authorizing that key applies to every client holding it; different Bot names do not isolate a shared key.

After authorization, the AI can discover its permitted links with:

```javascript
list_onepassword_connections({})
```

To apply one within the user's authorized task, use the discovered link ID:

```javascript
use_onepassword_connection({ "id": "LINK_ID_FROM_DISCOVERY", "confirmed": true })
```

Clients using the established connection/action interface can discover provider `1password`, then its `list-connections` and `use-connection` actions. Inspect the live action schema before supplying arguments. REST key clients can use the corresponding tools through `POST /api/v1/tools/TOOL_NAME`; OAuth clients use MCP.

`confirmed: true` records the caller's intent to apply the saved credentials; it does not create permission or bypass a 1Password authentication prompt. Successful retrieval/application is not evidence that every destination action succeeds. Inspect the safe result and verify a read or readiness check for that destination. Never request raw vault contents, copy secret values into the conversation, or use arbitrary commands to extract them.

To pause new retrievals, clear **Enable 1Password credential retrieval** and click **Save 1Password setup**. Previously imported credentials and connected accounts remain saved; pausing 1Password does not revoke credentials already used by a destination. Use the destination's normal disconnect or credential-revocation controls when that is your intent.

## What requires your approval

The desktop app integration uses 1Password's own authentication. It can prompt after inactivity, a restart, or when 1Password has locked. A locked vault is not an error to bypass. Automated use may wait for the owner to unlock and approve access on the Connector PC.

1Password documents a ten-minute idle authorization window and a twelve-hour maximum, with access revoked when the desktop app locks. Connector does not collect a 1Password account password or Secret Key to avoid these prompts. Already imported Connector credentials continue to use Connector's normal encrypted storage and provider refresh behavior.

## CLI and MCP serve different purposes

Connector uses the official **1Password CLI** to read selected vault fields. The current **1Password Environments MCP Server** manages Developer Environments, lists variable names, and creates supported local environment mounts; it deliberately does not return secret values. It is not an API for retrieving arbitrary vault logins, and local `.env` mounts currently support macOS and Linux only.

The MCP server is optional and unnecessary for this Connector credential workflow. If you separately want an AI to manage 1Password Developer Environments, enable **Settings → Developer → Integrate with MCP clients** in 1Password, configure that local AI client to launch `1password-mcp`, and approve its connection in the desktop app. Keep the client configuration and Environment access scoped to that separate task. Connector setup does not overwrite existing MCP configurations.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| CLI unavailable | Run **Setup 1Password**, install the CLI, restart Connector, and check again. Use Connector's optional executable-path setting if the CLI is outside its usual locations. |
| No accounts or approval required | Open/unlock the desktop app under the same Windows user, enable **Integrate with 1Password CLI** and Windows Hello, then approve the prompt. |
| Expected item is missing | Select the correct 1Password account and vault. The signed-in account must have access; archived items are not offered. |
| A saved field is missing | The item may have been edited or moved. Review and update the saved link's item/field mapping. Connector does not guess another credential. |
| AI cannot see or use a link | Check the specific calling credential's permission on that link and whether 1Password access is paused. OAuth approval or a general Connector key alone does not grant link access. |
| Provider rejects imported credentials | Confirm the mapped field and credential type, provider permissions, and current value in 1Password. OAuth connections still require official sign-in and consent. |
| Vault locked during scheduled work | Unlock and approve 1Password locally, then retry within the user's intent. The previously imported destination credential is separate from current vault availability. |

Official references: [CLI setup](https://www.1password.dev/cli/get-started), [desktop integration](https://www.1password.dev/cli/app-integration), [authorization behavior](https://www.1password.dev/cli/app-integration-security), and [Environments MCP Server](https://www.1password.dev/environments/mcp-codex-server).
