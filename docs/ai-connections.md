# Connect Claude, ChatGPT, and Grok using your subscription

Your AI app runs the model using your existing subscription. Connector gives that app tools for the destination accounts you have connected. **You do not need an Anthropic, OpenAI, or xAI developer account, developer API key, or API billing to use this connection.** Your AI app must support custom MCP connections on your plan and allow the actions you want to perform.

The default connection uses OAuth: you paste one public Connector URL into the AI app, sign in with your **Connector workspace password**, and approve access. Connector and the AI app exchange their connection credentials automatically. Never paste your Claude, ChatGPT, or Grok password into Connector.

Social networks, advertising platforms, Google, and other destination services still have their own API permissions and application setup requirements. Their costs and approvals are separate from the AI connection.

To remove incorrect or stale connection details, use **Disable and reset** in **AI connections**. Registered OAuth clients can be reset individually, including unfinished attempts. The advanced shared API key has a separate reset affecting every AI client using that key. Follow the [reset guide](reset-connectors.md#claude-chatgpt-grok-and-other-ai-clients) before adding the connection again.

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

### Grok

Use this section **if your Grok account offers the custom connector URL setting where you previously added Zernio**. A consumer Grok custom-MCP feature and its exact menus could not be independently confirmed from public official documentation; this guide does not assume that every Grok account has it.

1. In Connector's **AI connections** page, select **Grok** and click **Open Grok**. Sign in to the same account where you used Zernio.
2. Open the connector settings you used for Zernio. Choose the option to add a custom connector and name it **Connector**.
3. Paste the **Connector URL**. If offered a transport, choose **Streamable HTTP**. If offered authentication, choose **OAuth**.
4. Continue to Connector's authorization page and complete section 3 below. Then return to Grok and enable the connector for the conversation if required.
5. Follow section 4 to check the connection.

If this Grok interface accepts **only a URL and API key**, use the advanced Connector-key steps below. That key comes from this app; it is **not** an xAI developer key. If the interface does not support custom MCP connections or the required transport/authentication, Connector cannot provide a direct connection from that interface. Do not buy xAI API access to complete these steps.

## 3. Approve the AI connection

1. Check that the authorization page is at your own public Connector address. The page is headed **Authorize an AI connection** and shows the requesting client's name. A client-supplied name is not proof of its identity; start this flow from the AI app you intend to connect.
2. Enter your **Connector workspace password** when asked. This is the password you chose when setting up Connector, not your AI account password.
3. Check **Standard platform tools** if this AI should use your social, advertising, communications, website, bank-data, and Obsidian connections. This permits all standard platform connections, including ones you add later; it is not an individual-platform selector. Plaid remains read-only. Leave it unchecked for a Google-only agent.
4. Under **Google Workspace agent profile**, choose the profile you created for this AI, or leave **No Google Workspace access** selected. Review the account email addresses, apps, and default account shown. Selecting a profile does not give access to other Google accounts or apps.
5. Select at least one access option, then click **Approve selected access**. To stop without granting access, click **Deny access**.
6. The browser returns to the AI app. Finish any confirmation shown there. Connector's **Approved AI connections** list now records the grant.

One OAuth connection can include standard platforms and a selected Google Workspace profile. Create different profiles for different AI agents when they should use different Google accounts or apps. Profile permission edits take effect on subsequent requests without signing the Google accounts in again.

## 4. Check that it works

Start with a read-only request in the AI app:

> Use Connector to list the accounts you can access. Do not publish, send, edit, schedule, or delete anything.

The AI should use `list_connections` for approved standard platforms and/or `list_workspace_accounts` for the selected Google profile. The displayed accounts should match your approval. An answer based only on chat history is not a connection test; inspect the app's tool activity when available. Return to **AI connections** and click **Refresh AI connections**. Under **Approved AI connections**, the grant should now show **Last successful tool call** and a time. **Approved; waiting for the first successful tool call** means the sign-in succeeded but Connector has not yet recorded a successful tool call.

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

Use this only when the client supports key authentication but not the OAuth flow above. It still requires no AI developer account.

1. Open **AI connections**, expand **Advanced: connect with a Connector API key**, and click **Show Connector API key**.
2. Copy the public **Connector URL** into the AI client's MCP URL field.
3. Copy the revealed **Connector API key** into the client's API-key field. If it asks for a header, use `Authorization: Bearer YOUR_CONNECTOR_KEY` or `X-API-Key: YOUR_CONNECTOR_KEY`. Never append the key to the URL.
4. Save and run the read-only connection check above.

The general key grants access to all standard platform connections. It does not grant Google Workspace access and cannot be revoked as an individual OAuth connection. For a Google-only key connection, use the agent profile key from **Google Workspace** instead; such a client needs separate standard and Workspace entries to access both. Keep existing key connections if they already work; OAuth is the simpler method for new compatible clients.

The app retains optional developer API integrations for existing users. The standalone `npm run grok` bot calls the separately billed xAI API. It is not used when connecting your subscription through these instructions.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| An Anthropic, OpenAI, or xAI developer-key form | Return to **AI connections**. Those forms belong to optional developer API integrations, not the subscription connection. |
| A public-address warning | Start public access under **Settings**, then copy the resulting HTTPS `/mcp` URL. |
| The AI cannot reach the server | Keep the PC awake, Connector running, and public access on. Open **Open public workspace** to check the address. Check for tunnel errors or an expired tunnel session in Settings. |
| No custom-app or connector setting in the AI app | Check the AI provider's current plan and workspace-admin requirements. This server cannot add a missing client feature. |
| Invalid or expired authorization | Restart the connection from the AI app; do not reuse an old authorization-page bookmark. Check that the public address has not changed. |
| No tools for the expected account | Check the grant in **AI connections**, the destination's connection status, and any selected Google profile's account/app permissions. Refresh/reconnect the AI app's tool list after changing access if required. |
| Google asks you to sign in again | Google consent/token expiry is separate from AI OAuth. Reauthorize that Google account in **Google Workspace**; retain its existing agent profile. |
| A new ngrok address after restarting | Copy the new URL from **AI connections** and reconnect the affected AI apps. Update destination OAuth redirect addresses where needed. A stable public domain avoids this change. |

See also [the MCP protocol guide](pipeline.md), [Windows update instructions](windows.md#update-without-reconnecting-your-accounts), and [Google Workspace permissions](providers-workspace.md).

## Reference guides

- [OpenAI's official Apps SDK examples: testing in ChatGPT](https://github.com/openai/openai-apps-sdk-examples#testing-in-chatgpt).
- [OpenAI's authenticated MCP server example](https://github.com/openai/openai-apps-sdk-examples/blob/main/authenticated_server_python/README.md).
- [Zernio's Claude plugin and connector instructions](https://github.com/zernio-dev/zernio-claude-plugin), describing the OAuth connection pattern this app implements with its own URL.
- [MCP authorization specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx).
