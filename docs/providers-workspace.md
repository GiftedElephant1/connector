# Google Workspace accounts and AI agent permissions

Connector can keep several Google accounts connected at the same time. Each AI agent gets a separate connector key and an explicit list of accounts and apps it may use. Adding an account or an app does not remove your existing social, advertising, WordPress, Mailchimp, or Google connections.

For example, give **Grok — business** access to Sheets, Gmail, and Tasks on `business@example.com`, and give **Claude — personal** access to Docs and Drive on `personal@gmail.com`. You can also let one agent use several accounts. Choose a default account or ask the agent to specify an account for each operation.

## One-time Google app setup

Google requires your own OAuth application for this locally hosted connector. Its client ID and secret are shared by all the Google accounts you add; each account still authorizes its own permissions.

1. Open [Google Cloud Console](https://console.cloud.google.com/) and sign in.
2. Use the project selector at the top to select a project, or click **New project**, enter a name, and click **Create**.
3. Open **APIs & Services → Library**. Enable the APIs for the apps you plan to use: Google Sheets API, Google Docs API, Google Slides API, Gmail API, Google Drive API, Google Meet REST API, Google Chat API, Tasks API, and Admin SDK API for Voice audit reports.
4. Open **Google Auth Platform**. If prompted, click **Get started** and enter the app name, support email, audience, and contact email.
5. Choose an **External** audience when connecting personal Google accounts or accounts outside your organization. In testing mode, add every account you intend to connect under **Audience → Test users**.
6. Open Connector in your browser and open **Google Workspace**. Copy the Google callback URL shown there. If using the public connection address, first open that address and sign in there so Google returns to the same browser session.
7. Back in Google Cloud, open **Google Auth Platform → Clients → Create client**. Choose **Web application**, name it, and paste the callback URL under **Authorized redirect URIs**. Click **Create**.
8. Copy the client ID and client secret into Connector's Google connection settings and save them. These are app credentials; they are not your Google account password.
9. For Google Chat, also complete the Google Chat API configuration in your project. Google Workspace administrators may need to allow the app and requested scopes.

Google may require app verification for sensitive or restricted scopes, particularly Gmail and Drive. External apps left in Google's **Testing** publishing status normally receive refresh tokens that expire after seven days when these scopes are used. Connector cannot extend Google's token lifetime; move to an appropriate production setup and complete Google's requirements for long-term use. Workspace administrators can also restrict access. See [Google OAuth production requirements](https://developers.google.com/identity/protocols/oauth2/production-readiness) and [refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Add a Google account

1. In Connector, open **Google Workspace**.
2. Select the apps you want to enable and choose the button to add a Google account.
3. Google's sign-in page opens. Choose the intended account, or choose **Use another account**.
4. Review the requested permissions and approve the apps you selected.
5. Google returns you to Connector. Check the email address on the account card.
6. Repeat these steps for another Google account.

Connector records the permissions Google actually granted. If you deselect a permission on Google's consent page, the affected app appears as needing authorization and cannot be assigned to an agent. To add permissions later, use that account's authorization control and select the additional apps. Existing permissions are included in that request. Selecting a different Google account during reauthorization produces an error and preserves the original connection; use the add-account flow for a new account.

## Give an AI agent access

1. In **Google Workspace**, create an AI agent profile and name it, such as **Grok — work**.
2. Select the Google accounts this agent may use. Check their exact email addresses.
3. For each selected account, choose the apps the agent may use.
4. Optionally choose a default Google account. With no default, the agent must specify an account ID when calling an app action.
5. Save the profile. Copy its new API key immediately: Connector displays it only when created or rotated.
6. In your AI agent's connector settings, add the displayed MCP URL and this profile's API key. Use Streamable HTTP with the key as a Bearer token if the client asks for the authentication format.
7. Ask the agent to list its permitted Workspace accounts, then ask it to perform an operation with the chosen account and app. Write operations require explicit confirmation through the tool's confirmation argument.
8. Create a separate profile and key for each additional agent. Reusing a key gives both agents the same permissions.

The existing general connector key continues to work for your existing platform connections. Workspace profile keys grant only the Workspace permissions in that profile. To use both groups from one AI client, configure the general connection and its Workspace connection separately when the client supports multiple connectors.

Edit a profile to change its permitted apps or accounts without signing those Google accounts in again. Removing a permission takes effect on the next request. Rotate a key if you need a replacement; the previous key stops working immediately. Delete a profile to revoke that agent's access while retaining the connected Google accounts. Disconnecting one Google account removes only that account and its agent bindings.

## What the apps can do

| App | Supported operations and limits |
| --- | --- |
| Sheets | Read and update spreadsheet cells; create spreadsheets. |
| Docs | Read and create documents; append text. |
| Slides | Read and create presentations; add text slides. |
| Gmail | Search and read messages; create drafts; send plain-text email. |
| Drive | Search file metadata; create folders and text files. Content access uses `drive.file`, so it is limited to files created or opened with this app. |
| Maps | Search public places and read place details using a separately configured Google Cloud project key. Personal saved places and Timeline are unavailable. |
| Meet | Create meeting links; read spaces; list accessible conference records. Requires an eligible Google Workspace account. |
| Voice | Read Google Voice audit events as an authorized Workspace administrator. Personal calls, SMS, and voicemail are unavailable through the official API. |
| Chat | List spaces and messages; send text messages as the selected user. Requires an eligible account and Google Chat API configuration. |
| Tasks | List task lists and tasks; create tasks; mark tasks complete. |

Google permissions and subscription requirements still apply. An OAuth grant confirms the selected permissions, while individual API operations may require the relevant Google API to be enabled, organization approval, or an eligible subscription. Voice audit access requires administrator reporting privileges and does not provide control of a personal Voice account.

## Add a Maps project key

Google Maps Platform uses a billed project rather than access to a person's Maps account. Connector associates a project key with a chosen Google account to make agent permissions and project selection clear.

1. In [Google Cloud Console](https://console.cloud.google.com/), choose the project that should pay for Maps usage.
2. Enable **Places API (New)** and configure billing for that project.
3. Open **APIs & Services → Credentials → Create credentials → API key**.
4. Restrict the key to **Places API (New)**. If your server has a stable outbound IP address, use an appropriate server IP restriction. Browser referrer restrictions do not work for this server-side connection.
5. Copy the key. In Connector, find the intended Google account and save the key in its Maps connection control.
6. Edit the intended agent profile and enable Maps for that account.

A different Google account can have a different Maps project key. Removing a key immediately disables Maps actions for that account's agent profiles; other Google apps remain connected.

## Preserving connections when adding connectors or updating

Google refresh tokens, Maps project keys, and account settings remain in Connector's encrypted local database. Agent keys are stored as hashes. Use the provided update workflow, which preserves the database and encryption key. Do not delete the `data` folder or replace the encryption key when updating: both are needed to retain connections.

New connectors can be added without changing your existing account credentials. You authorize only the new account or newly requested permissions. Google or another provider can still require sign-in again when you revoke consent, change security settings, exceed refresh-token limits, or let a testing-mode token expire.

## Backend details

- Owner-only dashboard routes live under `/api/workspace` and use the normal authenticated browser session and origin checks.
- Google callback: `/api/workspace/google/callback`. Authorization state is encrypted, expires after ten minutes, is bound to one browser session, and is consumed once. Authorization uses PKCE and offline access.
- Account IDs are stable opaque values derived from the verified Google subject, not user-supplied email addresses. Reauthorizing an account cannot replace it with another Google identity.
- Credential rows use `google-workspace:<accountId>`; metadata and agent profiles use encrypted settings. Existing provider rows and scheduled jobs keep their existing identifiers.
- Apps are enabled only when all their required scopes are present in Google's returned grant. A scope reduction during refresh disables access through existing bindings.
- Agent API keys contain 32 random bytes and are returned only once. Fresh profile and key checks enforce permission changes, rotation, and revocation on subsequent requests.
- Token refresh is serialized separately for each account. Rotated refresh tokens are saved, and disconnecting an account during refresh cannot recreate its connection.
