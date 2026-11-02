# Connect Claude, ChatGPT, Gemini, Cursor, and Grok Bot

Connector gives an AI client access to the destination accounts you have connected. Claude, ChatGPT, Gemini, and Cursor use its MCP tools; Grok Bot can call its authenticated HTTPS API from the Bot's cloud computer. **These connections do not call model APIs or require a model-provider developer key.** Model access and usage remain subject to the AI product's plan. The Grok Bot card prepares a message with this installation's connection instructions; verify access with a real account-list request.

The MCP connection uses OAuth: you paste one public Connector URL into the AI app, sign in with your **Connector workspace password**, and approve access. Connector and the AI app exchange their connection credentials automatically. Never paste your AI account password into Connector.

Social networks, advertising platforms, Google, and other destination services still have their own API permissions and application setup requirements. Their costs and approvals are separate from the AI connection.

To remove incorrect or stale connection details, use **Disable and reset** in **AI connections**. Registered OAuth clients can be reset individually, including unfinished attempts. The advanced shared API key has a separate reset affecting every AI client using that key. Follow the [reset guide](reset-connectors.md#claude-chatgpt-grok-bot-and-other-ai-clients) before adding the connection again.

## 1. Start Connector and make it reachable

If you already have a working public HTTPS address in Connector, continue at step 8.

1. Open the folder where you installed Connector and double-click **Start Connector**. After startup, Connector runs in the Windows notification area beside the clock; you can close its window and browser while your AI app uses it. Right-click its icon (under **Show hidden icons** if needed) to reopen or stop it.
2. In the browser dashboard, sign in if asked. Use the workspace password you chose for Connector.
3. Click **Settings** in the sidebar. Find **Make Connector available to your AI agent**.
4. Click **Open ngrok’s Your Authtoken page**. This opens [ngrok's token page](https://dashboard.ngrok.com/get-started/your-authtoken) in another tab. Sign in or create an ngrok account if needed; this is the service that makes the app on your PC reachable through HTTPS.
5. On **Your Authtoken**, click the copy icon beside the token. Use this copy control instead of selecting hidden dots or copying the page address. This is the authtoken, not an ngrok API key. The current app also accepts the full `ngrok config add-authtoken` line when it contains your actual token; a placeholder such as `$YOUR_AUTHTOKEN` will not work.
6. Return to Connector's Settings tab. Click inside **ngrok authentication token**, press **Ctrl+A** to select any old contents, then **Ctrl+V** to paste. Click **Start public access**. Connector installs and runs the tunnel itself; no PowerShell command is needed. Wait for **Public access is on**.
7. Click **Open public workspace**. If ngrok shows a browser notice, continue to the site. Sign in with your Connector workspace password.
8. In **Connections**, connect the destination accounts your AI should use. Existing connections stay saved; there is no need to reconnect them for this feature.
9. If you want to use Google Workspace, open **Google Workspace**, connect the intended Google accounts, and create an agent profile with the allowed accounts and apps. Follow the [Workspace guide](providers-workspace.md). You will select this profile during AI authorization.
10. Open **AI connections** in the sidebar. Find **Connector URL** and click **Copy** beside it. The address must start with `https://` and end in `/mcp`. If the page shows **Set up public address**, finish the public-access steps above first.

Cloud AI services cannot reach `http://127.0.0.1:3000` on your PC. Keep your PC on, awake, signed in, online, and running Connector while the AI uses its tools or while scheduled work is due. Locking the PC is fine if it remains awake. No browser or Connector window needs to stay open. A browser bookmark opens an already-running Connector; it does not start the app.

## 2. Add Connector to your AI app

Repeat the appropriate section for each AI app. A separate authorization lets you revoke one AI connection without disconnecting your destination accounts or the other AI apps. Client menus and plan availability can change; follow the linked provider instructions if a menu has moved.

### Claude

1. In Connector's **AI connections** page, select **Claude** and click **Open Claude**. Sign in to the Claude account that has your subscription.
2. In Claude, open **Settings → Connectors** and choose **Add custom connector**.
3. Enter **Connector** as the name and paste the **Connector URL** you copied. Add the connector. This is your app's `/mcp` address, not an Anthropic API endpoint.
4. Click **Connect** if Claude displays that button. OAuth opens Connector's authorization page. You do not need to supply your own OAuth client ID or secret; registration is automatic for clients supporting this flow.
5. Complete the approval steps in section 3 below, then return to Claude.
6. Open a conversation and enable Connector in the conversation's tools/connectors menu where required. Follow section 4 to check the connection.

Claude Max supplies the model usage for this workflow. It does not need separately billed Anthropic API access. Organization administrators can restrict custom connectors.

### ChatGPT

1. In Connector's **AI connections** page, select **ChatGPT** and click **Open ChatGPT**. Sign in to your subscription account.
2. In ChatGPT, open **Settings → Apps** (called **Connectors** in some versions). If your account requires developer mode for custom apps, open **Advanced settings** and enable **Developer mode**. This setting is inside ChatGPT; it does not require an OpenAI developer account or API billing.
3. Choose **Create app** or **Create connector**, depending on the version shown. Enter **Connector** as the name and a short description, such as **Use my connected accounts**.
4. Paste the **Connector URL** into the MCP server URL field and choose **OAuth** authentication. Leave optional OAuth client ID/secret fields blank when the client supports automatic registration. Do not select **No authentication**.
5. Continue the app creation/connect flow. Complete Connector's approval screen using section 3 below. Review ChatGPT's own custom-app notice when prompted.
6. Return to a ChatGPT conversation and select Connector from its apps/tools menu. Follow section 4 to check the connection.

Custom app creation, write tools, and developer mode depend on your ChatGPT plan and workspace policy. Enabling this server cannot unlock a missing ChatGPT feature. OAuth does not cause Connector to call the separately billed OpenAI model API.

### Gemini website and mobile app

Google's [custom-app instructions](https://support.google.com/gemini/answer/17209137?hl=en) currently require a **personal Google Account, age 18 or over, US availability, English, and Keep Activity turned on**. Work and school Google Accounts are not eligible for this Gemini feature. Configure the connection on the Gemini website first; afterward, the same custom app is available in Gemini's website and mobile app. This setup does not use Gemini CLI or a Gemini model API key.

1. Complete section 1 so Connector has a running public HTTPS address. In **AI connections**, select **Gemini**, copy **Connector URL**, and click **Open Gemini**.
2. Sign in to Gemini with the eligible personal Google Account you want to use. Check that **Keep Activity** is on if custom apps are unavailable.
3. On the Gemini website, click **Settings → Connected Apps**. If **Connected Apps** is not shown there, open **Personal Intelligence → Connected Apps** instead. You can also open [Gemini's Connected Apps page](https://gemini.google.com/apps) directly.
4. Under **Custom apps**, use **Add a custom app link to get started**, or click **Add a custom app** if you already have one.
5. Paste the current **Connector URL**, including `/mcp`, and click **Next**. Leave advanced client credentials blank: Connector supports automatic registration, so you do not need a developer application, client ID, or client secret for this AI connection.
6. Follow the browser's authorization flow. On your Connector address, sign in with your Connector workspace password and choose the access described in section 3 below. Return to Gemini and finish any confirmation.
7. In a new Gemini conversation, enter **@** and select your custom Connector app. Run the read-only account-list check in section 4 before asking for writes. Gemini currently requires manual confirmation for custom-app writes, in addition to Connector's write confirmation.
8. To use it on your phone, open the Gemini mobile app with the same Google Account, enter **@**, and select the connected custom app. Keep the PC running Connector awake and online; the mobile connection does not move Connector onto your phone or into Google's cloud.

If **Custom apps** is unavailable, check Google's current eligibility requirements. An account or region outside the supported rollout cannot be enabled by Connector. Your Gemini sign-in is separate from Google Workspace access through Connector: the selected Connector profile determines which already-connected Google accounts and apps Gemini may use.

### Cursor

1. Install or update [Cursor](https://cursor.com/downloads), open it, and sign in to the Cursor account you want to use. The **Download Cursor** link on Connector's Cursor card opens its download page. Its own plan supplies model access; Connector does not need a model API key.
2. In Connector, open **AI connections**, select **Cursor**, and click **Add to Cursor**. Allow the browser to open Cursor if prompted.
3. Review the proposed server before adding it. Its name should be `connector` and its URL should be your current public Connector address ending in `/mcp`. The installation link contains the server configuration, not your password or a Connector key.
4. In Cursor's **Customize** area, find the MCP server, enable it, and use its sign-in/authentication control if prompted. Complete Connector's OAuth approval in section 3 below, then return to Cursor.
5. Open an Agent conversation with the Connector tools enabled and run the read-only account-list check in section 4. Keep Cursor's tool-approval controls enabled; adding a server does not approve arbitrary writes.

If the browser cannot open Cursor, add the configuration manually:

1. In Cursor, open your user MCP configuration, `~/.cursor/mcp.json`, or create `mcp.json` in that folder if it is missing. On Windows, this is `%USERPROFILE%\.cursor\mcp.json`; open that location from File Explorer or Cursor's file-opening dialog. A project's `.cursor/mcp.json` limits the configuration to that project instead.
2. On Connector's Cursor card, click **Copy Cursor configuration**, or expand **View Cursor configuration** and copy the text manually. For a new file, it has this structure; replace the example URL below with **Connector URL** from your dashboard:

   ```json
   {
     "mcpServers": {
       "connector": {
         "url": "https://YOUR_CONNECTOR_ADDRESS/mcp"
       }
     }
   }
   ```

3. If the file already contains settings, add or update only the `connector` entry inside its existing `mcpServers` object. Preserve other servers and settings; do not replace the entire file or create a second `mcpServers` object. No `headers`, model API key, or Connector password belongs in this OAuth configuration.
4. Save the file, return to Cursor's MCP settings, and complete the authentication and read-only check above.

Cursor and Grok Bot are separate connection choices even if they use the same account sign-in. Adding Cursor here does not change Grok Bot's existing credentials or your connected destination accounts.

### Grok Bot

Grok Bot has a persistent cloud computer with a browser and command line. The **Copy instructions for Grok Bot** button prepares a message that tells your Bot how to call Connector's HTTPS API from that computer. It includes your public API address and supported requests, but no passwords or API keys. You do not need to type commands yourself.

1. Complete section 1 above so Connector is running and **Public access is on**. Your existing destination accounts stay connected.
2. Install Grok Bot from [x.ai/bot](https://x.ai/bot) if needed. For Windows, choose **x64** or **Arm64** to match **Settings → System → About → System type**, run the installer, then open **Grok Bot** from the Start menu.
3. Choose **Sign in** and complete the Cursor account sign-in in your browser. Return to Grok Bot. If your access comes from SuperGrok, follow the app's prompt to link that subscription. Review [Grok Bot's current access and billing requirements](https://cursor.com/help/grok-bot/plans); no xAI developer account is needed for this connection.
4. Open an existing Bot, choose a suggested teammate during first setup, or use **New → Create new Bot**. Give it a name and job, then open its conversation.
5. In Connector, open **AI connections**, select **Grok Bot**, and click **Copy instructions for Grok Bot**. Return to the Bot's conversation, paste the message, and send it. If the copy button is unavailable, finish public-address setup first.
6. Choose the access you want to give it. For social, advertising, communications, WordPress, and other standard connections, expand **Advanced: connect with a Connector API key** in Connector, then click **Show Connector API key** and copy the key. This key permits all standard connected platforms and future standard additions. For Google Workspace, use a key from the intended agent profile instead; see the [profile instructions](providers-workspace.md#grok-bot-and-other-clients-using-the-https-api). Standard access and Workspace access require separate keys.
7. Give the key to Grok Bot only through a supported **secure secret request**, where the value is masked and excluded from the conversation. If that is unavailable, have the Bot prepare a masked terminal prompt, choose **Take over**, enter the value yourself, and choose **I'm done**. The prompt must not echo or log the key or save it in command history. Do not paste the key into chat, the public URL, a shared file, or a skill. The Bot should send it only to your Connector origin in an `Authorization: Bearer ...` or `X-API-Key` header.
8. Have the Bot make the first read-only request: `GET /api/v1/connections` with the standard key, or `GET /api/v1/workspace/accounts` with a Workspace profile key. Inspect the returned account list and any error before requesting work. These REST requests do not create an entry under **Approved AI connections** or update OAuth's **Last successful tool call** field; the actual request and response verify this route.
9. Once that works, ask the Bot to inspect the available actions for a connected account. Give it explicit instructions for any publishing, scheduling, sending, editing, or campaign changes. Connector requires write confirmation and a unique request ID; the copied message explains those requirements. A request accepted by an advertising or social platform can still require later processing or approval.

Refresh `list_workspace_actions` after Connector updates before reporting a missing feature. Sheets supports formulas, tabs, formatting, and batch updates; use `write-formulas` or `write-values` with `USER_ENTERED` to calculate formulas. For Drive logos and other stored files, use **Drive → download-file** and decode the returned `contentBase64` into a local file, checking `size` and `sha256`. Stored-file downloads and binary uploads support up to 20 MiB; **export-file** supports native Google documents up to 10 MiB. **upload-file** can convert an Excel workbook to Google Sheets. Read/encode/decode the bytes in code and keep them out of chat and terminal output. If discovery reports `missingPermissions` or `driveDownloads: false`, follow [the Google permission upgrade](providers-workspace.md#update-an-existing-connection-for-expanded-actions) on the existing account, then retry with the same Workspace profile key. Metadata search alone does not grant file-content access.

**All Bots on your Grok Bot account share one cloud computer, including files, browser sessions, and command-line credentials.** Installed plugins are also account-wide. Each Connector key limits the requests made with that key; it cannot prevent another Bot on that shared computer from using a credential available there. Do not put a key on that computer if another Bot on the same account must not have its access. Separate Bot names and profile labels do not create a security boundary.

Grok Bot's documented plugin flow is **Connect apps → Add → browser authentication**, then type **@** in chat to attach an installed connector. Its current documentation also supports adding an external MCP server by URL or command. Use Connector's `/mcp` URL and section 3 below when configuring compatible Streamable HTTP MCP with OAuth. The guided HTTPS API route remains available. This project does not claim a marketplace listing or a live test with your Bot account.

These instructions let an AI app call Connector. To let Grok Bot or another authorized client send work to Claude, ChatGPT, Gemini, Cursor, or a Grok Bot routine, configure the separate [outbound AI integrations](outbound-ai.md). For Grok Bot using the existing general Connector key, enable and save shared-key delegation access; no Grok entry under **Approved AI connections** is expected. Existing OAuth approvals need their own explicit **Enable AI delegation** confirmation in that list. Neither route requires resetting a working Connector key or disconnecting platform accounts.

After an update, have the Bot refresh its live connection and action lists. Outbound destinations now appear alongside platform accounts in `connections`; `list_actions` for `claude` returns the Claude delegation actions. `connectorVersion` and `authentication` identify the running server and whether the Bot is using a key or OAuth. An incoming Claude approval is not evidence that the outbound Claude destination is configured or that Grok has permission to use it.

Grok Bot can continue cloud work with its app closed, but this Connector installation remains on your PC. Keep that PC awake, online, and running Connector with public access on while the Bot needs it. The browser and Connector window may remain closed. The optional xAI API client below is a separate developer tool and is not part of this setup.

## 3. Approve an MCP OAuth connection

1. Check that the authorization page is at your own public Connector address. The page is headed **Authorize an AI connection** and shows the requesting client's name. A client-supplied name is not proof of its identity; start this flow from the AI app you intend to connect.
2. Enter your **Connector workspace password** when asked. This is the password you chose when setting up Connector, not your AI account password.
3. Check **Standard platform tools** if this AI should use your social, advertising, communications, website, and Obsidian connections. This permits all standard platform connections, including ones you add later; it is not an individual-platform selector. Leave it unchecked for a Google-only agent.
4. Under **Google Workspace agent profile**, choose the profile you created for this AI, or leave **No Google Workspace access** selected. Review the account email addresses, apps, and default account shown. Selecting a profile does not give access to other Google accounts or apps.
5. Check **Send tasks to AI agents** only if this connection should delegate your authorized work to the outbound AI destinations enabled in Connector. This is separate from standard platform and Google access and can consume the destination's subscription usage.
6. Select at least one access option, then click **Approve selected access**. To stop without granting access, click **Deny access**.
7. The browser returns to the AI app. Finish any confirmation shown there. Connector's **Approved AI connections** list now records the grant.

One OAuth connection can include standard platforms and a selected Google Workspace profile. Create different profiles for different AI agents when they should use different Google accounts or apps. Profile permission edits take effect on subsequent requests without signing the Google accounts in again.

To change delegation for a live OAuth connection, use **Enable AI delegation** or **Disable AI delegation** on its entry under **Approved AI connections**. Review the connection details and confirm the change. This preserves the grant's other access and current tokens; it does not require a new sign-in. Disabling delegation blocks further task access but does not stop tasks already running. Cancel supported tasks separately in **AI task history**.

## 4. Check that it works

Start with a read-only request in the AI app:

> Use Connector to list the accounts you can access. Do not publish, send, edit, schedule, or delete anything.

An MCP client should use `list_connections` for approved standard platforms and/or `list_workspace_accounts` for the selected Google profile. A Grok Bot using REST should make the corresponding HTTPS account-list request in its setup steps above. The displayed accounts should match the access granted. An answer based only on chat history is not a connection test; inspect the app's tool activity when available. For an OAuth connection, return to **AI connections** and click **Refresh AI connections**. Under **Approved AI connections**, the grant should now show **Last successful tool call** and a time. **Approved; waiting for the first successful tool call** means the sign-in succeeded but Connector has not yet recorded a successful tool call.

Then ask it to inspect a connected destination:

> Use Connector to list the available actions for my connected WordPress account. Do not change anything.

For Google Workspace, name the account and app explicitly:

> Use Connector to list the Sheets actions available on my Google account business@example.com. Do not change anything.

Replace the examples with accounts you have actually connected. Confirm the returned account and action names before requesting a write. For an Obsidian write test, you can ask the AI to create a new test note, inspect the proposed path and contents, approve it, and verify that the note appears in Obsidian. Read an existing note before editing it so the AI has the current content hash.

Connector requires explicit confirmation and a unique request ID for write actions. Your AI app may also ask for approval. After a timeout, check the result before requesting the same write again; the destination may have accepted it already.

The project's automated tests check the server's authorization and tool behavior. Signing in and making the read-only call above checks your actual AI account, plan, network address, and destination permissions. A saved OAuth grant confirms authorization; it does not establish that every destination action is available or that every AI client has been tested live.

## Revoke or change access

1. Open **AI connections** in Connector.
2. Find the entry under **Approved AI connections**. Check its client name and approved access.
3. Click that entry's **Revoke access** button, then **Confirm revoke access**.
4. Future calls using that grant are rejected. Remove the saved app/connector from the AI client too if you no longer want it listed there.

Revoking an AI grant preserves your connected platform accounts and Google profiles. It does not undo completed actions or cancel already-approved scheduled posts. Cancel unwanted pending jobs in **Schedule** separately. To change the standard-platform/Google-profile selection for an AI, revoke its grant and connect it again. To narrow Google account/app access within an existing profile, edit the profile in **Google Workspace**.

AI authorizations expire after 30 days. Reconnect and approve that AI when its authorization expires; this does not require reconnecting your destination accounts. Connector shows the expiration in its approved-connection list. Public-address changes and explicit revocation can require authorization sooner.

## Advanced: an AI client that accepts a Connector API key

Use this for a client using Connector's HTTPS API, such as Grok Bot, or a compatible MCP client using key authentication. This is a Connector key, not an AI developer key.

1. Open **AI connections**, expand **Advanced: connect with a Connector API key**, and click **Show Connector API key**.
2. For an MCP client, copy the public **Connector URL** into its MCP URL field. For Grok Bot's HTTPS API route, use **Copy instructions for Grok Bot**, which includes the correct API base address.
3. Enter the revealed **Connector API key** only in the client's supported secure secret field or through the masked takeover prompt described above. Use `Authorization: Bearer YOUR_CONNECTOR_KEY` or `X-API-Key: YOUR_CONNECTOR_KEY` for requests. Never append the key to the URL or paste it into chat.
4. Save and run the read-only connection check above.

The general key grants access to all standard platform connections. It does not grant Google Workspace access and cannot be revoked as an individual OAuth connection. For a Google-only key connection, use the agent profile key from **Google Workspace** instead; a key-based client needs separate credentials for standard and Workspace access, using separate connector entries when required by an MCP client. Keep existing key connections if they already work; OAuth is the simpler method for new compatible clients.

The app retains optional developer API integrations for existing users. The optional **xAI API client**, started with the existing `npm run grok` command, calls the separately billed xAI API. It is separate from Grok Bot and is not required for the MCP or HTTPS API connections above.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| An Anthropic, OpenAI, or xAI developer-key form | Return to **AI connections**. Those forms belong to optional developer model API integrations; neither the MCP route nor the Grok Bot HTTPS route requires them. |
| A public-address warning | Start public access under **Settings**, then copy the resulting HTTPS `/mcp` URL. |
| The AI cannot reach the server | Keep the PC awake, Connector running, and public access on. Open **Open public workspace** to check the address. Check for tunnel errors or an expired tunnel session in Settings. |
| No custom-app or connector setting in the AI app | Check the AI provider's current plan and workspace-admin requirements. This server cannot add a missing client feature. |
| Gemini has no **Custom apps** option | Google's current requirements are US availability, English, age 18+, a personal Google Account, and Keep Activity on. Add the app on the Gemini website before using it on mobile. |
| **Add to Cursor** does not open the app | Install/open Cursor, allow the browser's external-app prompt, or use the card's configuration in your existing `mcp.json` as described above. |
| Invalid or expired authorization | Restart the connection from the AI app; do not reuse an old authorization-page bookmark. Check that the public address has not changed. |
| No tools for the expected account | Check the grant in **AI connections**, the destination's connection status, and any selected Google profile's account/app permissions. Refresh/reconnect the AI app's tool list after changing access if required. |
| Google asks you to sign in again | Google consent/token expiry is separate from AI OAuth. Reauthorize that Google account in **Google Workspace**; retain its existing agent profile. |
| A new ngrok address after restarting | Copy the new URL from **AI connections** and reconnect the affected AI apps. Update destination OAuth redirect addresses where needed. A stable public domain avoids this change. |

See also [the MCP protocol guide](pipeline.md), [Windows update instructions](windows.md#update-without-reconnecting-your-accounts), and [Google Workspace permissions](providers-workspace.md).

## Reference guides

- [Grok Bot: Get started](https://docs.x.ai/grok-bot/get-started), covering installation, Cursor sign-in, Bot creation, and takeover.
- [Grok Bot: Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps), documenting the shared computer, secure secret requests, and plugin flow.
- [Grok Bot: Settings and notifications](https://docs.x.ai/grok-bot/settings-and-notifications), including account-wide plugins and usage controls.
- [OpenAI's official Apps SDK examples: testing in ChatGPT](https://github.com/openai/openai-apps-sdk-examples#testing-in-chatgpt).
- [OpenAI's authenticated MCP server example](https://github.com/openai/openai-apps-sdk-examples/blob/main/authenticated_server_python/README.md).
- [Google: connect and manage custom apps for Gemini Apps](https://support.google.com/gemini/answer/17209137?hl=en), including web setup, mobile use, and account/region requirements.
- [Cursor: Model Context Protocol](https://cursor.com/docs/mcp) and [MCP installation links](https://cursor.com/docs/mcp/install-links).
- [Zernio's Claude plugin and connector instructions](https://github.com/zernio-dev/zernio-claude-plugin), describing the OAuth connection pattern this app implements with its own URL.
- [MCP authorization specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx).
