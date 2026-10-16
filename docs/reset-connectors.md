# Disable a connector and start again

Use **Disable and reset** when you entered the wrong application details, connected the wrong account, or want to remove a connector’s access and begin again. You do not need to reinstall Connector.

## Social, advertising, website, notes, and API connections

1. Open **Connections** and find the platform. The **Disable and reset** button is available even if connecting has never succeeded. It is also available from the platform’s setup screen and the provider list in **Settings**.
2. Click **Disable and reset** to open a preview. Nothing is changed by opening this dialog.
3. Read the affected connector list. Some platforms share developer-app details: for example, LinkedIn and LinkedIn Campaign Manager use the same Client ID and secret. Resetting those details resets the entire listed group. Other groups remain connected.
4. Click **Disable and reset** in the confirmation dialog. Connector clears the affected account credentials, developer-app settings, and unfinished sign-in attempts. It cancels pending scheduled jobs for those platforms. Previously saved values from the installation’s environment file remain overridden after restart, so they cannot silently restore the old setup.
5. Choose **Done** to leave the connector disabled, or **Set up again** to enter fresh application details or an API credential and authorize the correct account. For Obsidian, choose your vault folder again. Reconnecting does not restart cancelled jobs.

Published posts, advertising campaigns, platform-side content, local Obsidian notes, and activity history remain in place. Requests already sent to a platform may still finish. This is not a request to pause existing advertising campaigns or delete published content.

For most platforms, local reset does not revoke the developer app’s authorization on the provider’s website. Use that provider’s connected-app or API-token settings if you also want to revoke access there. Your provider’s browser session may remain signed in; switch accounts on its authorization screen when reconnecting if needed.

Resetting TikTok also removes its uploaded domain-verification file. If required for your replacement TikTok application, upload its new verification file during setup. The shared app icon and public Terms and Privacy pages remain available.

## Google Workspace

To reset one Google account, open **Google Workspace**, find the account, and choose **Disable and reset account**. Confirm to remove that account’s tokens, saved Maps key, and permissions in AI agent profiles. Other connected Google accounts remain saved. Unfinished Google sign-ins are cancelled so an old authorization cannot restore a removed account; restart any other sign-in you had in progress.

Use **Connect Google account** to authorize the account again, then explicitly give the intended AI profiles access to the accounts and apps they should use. Reconnecting does not silently restore removed permissions. A separate Maps reset removes just that account’s Maps key and related agent access.

If the Google developer Client ID or secret is wrong, choose **Disable and reset Google setup**. Its confirmation lists all affected Google connectors and Workspace accounts because they share the same developer credentials. After reset, enter the correct Google app settings and connect the desired accounts again.

## Claude, ChatGPT, Grok Bot, and other AI clients

Open **AI connections** and find the registered client you want to remove. Check its registration ID and return addresses as well as its display name. Choose **Disable and reset** and confirm. This removes that registration, every authorization and token belonging to it, and any unfinished authorization requests. Other AI registrations and destination accounts remain connected.

To start again, remove the old Connector entry in that AI app and add it again using the current Connector URL and OAuth connection instructions. The reset also supports registered clients whose first authorization never completed.

For AI clients using the advanced shared **Connector API key**, open **Advanced: connect with a Connector API key** and choose **Disable and reset shared API key**. Confirming replaces the key and immediately stops access through the old key for every client that used it. Choose **Show Connector API key** to retrieve the replacement and update only the AI clients you want to reconnect. OAuth authorizations and Google agent-profile keys are separate and remain unchanged.

Resetting an AI registration or shared API key stops future access through it. Jobs already scheduled are not attributed to an individual AI client, so they remain scheduled. Cancel unwanted jobs in **Schedule**, or reset the destination connector to cancel all its pending jobs.

Existing Google agent profiles can also be removed or have their keys replaced from **Google Workspace**. Removing a profile stops access through both its key and OAuth authorizations using it. Replacing just its key stops the old key; OAuth AI connections using that profile remain authorized. Neither control resets the Google accounts themselves.
