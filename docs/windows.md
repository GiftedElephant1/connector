# Use Connector on Windows

Download the Windows ZIP, extract it, and double-click **Start Connector**. You do not need to install Node.js or Git, type terminal commands, or edit a configuration file for first launch. Windows 10/11 on x64 or ARM64 and an Internet connection are required.

## Download and start

1. Open [Windows releases](https://github.com/GiftedElephant1/connector/releases) and download **Connector-Windows.zip** from a signed release. If no signed release is available, keep your current installation. GitHub source ZIPs and older **Package Windows app** downloads are unsigned development builds and may be blocked; they are not an alternate way around download protection. The current development workflow publishes verification reports only.
2. In File Explorer, right-click the downloaded release ZIP and choose **Extract All**.
3. Move the extracted **Connector** folder to a place you want to keep it, such as your Documents folder. Do not launch from inside the ZIP, a temporary preview, or a read-only folder.
4. Open the extracted **Connector** folder and double-click **Start Connector** (`Start Connector.vbs` if extensions are visible).
5. A small Connector window shows setup progress. On the first launch it downloads a private, checksum-verified Node.js runtime and installs the app components. This can take several minutes. Later launches reuse them.
6. Your default browser opens Connector automatically and signs you into this local desktop session. Once startup finishes, click **Hide to tray** or the small window's **X** to hide it in the notification area beside the Windows clock. You can close the browser too without stopping scheduled posts or remote access.
7. Follow the dashboard's connection setup. Configure required developer-app credentials in the dashboard, then choose **Connect account** and approve access on the provider's own site. Platforms still control eligibility, consent, business verification, API access, and approval.

The local app runs at `http://127.0.0.1:3000`. The launcher uses a private, short-lived browser sign-in handoff; it never puts your saved provider credentials into that address. A cloud AI service needs the dashboard's remote-access setup before it can reach an app running on your PC.

## Run in the background, stop, and reopen

1. Find Connector's icon in the notification area beside the Windows clock. If it is hidden, click the **Show hidden icons** arrow first.
2. Right-click the icon and choose **Open Connector** to open the dashboard, **Show status** to bring back the small window, or **View status log** to inspect startup status.
3. Close the browser whenever you want. If the small Connector window is visible after startup, **Hide to tray**, its **X**, or minimizing it hides it. Connector and its public connection continue running in the background.
4. To stop the app, right-click the icon and choose **Stop Connector**. The **Stop Connector** button in its window does the same thing. Closing the window during setup still cancels startup.
5. Double-click **Start Connector** in your original installation folder whenever you want to open it. If Connector is already running, this opens its dashboard. If it is still starting or needs attention, this brings back its existing status window. During an update, it brings back the updater. It does not start a second copy.

Opening **Start Connector** from a newly downloaded folder also reopens the active installation. To install the new version into your existing installation, use **Update Connector** as described below.

Keep your PC on, awake, signed in, and connected to the Internet for scheduled actions and remote access. Locking the PC is fine if it remains awake; sleeping, shutting down, signing out, or choosing **Stop Connector** makes Connector unavailable. Your scheduled jobs and connected accounts stay saved, but jobs cannot run while the app is stopped. A browser bookmark opens an already-running app; it does not start Connector.

## Start automatically when you sign in

1. Start Connector from the folder you intend to keep using.
2. In its small window, check **Start with Windows**. You can also right-click its notification-area icon and select **Start with Windows**. It is off by default.
3. On your next Windows sign-in, Connector starts in the background without opening its window or your browser. Use its icon beside the clock to open the dashboard when needed.
4. To stop automatic startup, uncheck **Start with Windows** using either control. Choosing **Stop Connector** stops the current session but does not turn off automatic startup for the next sign-in.

This starts Connector for your Windows user after sign-in, without administrator access. It does not run before sign-in or keep the PC awake. Keep the installation in the same folder; updates to that original folder preserve the startup setting. Startup errors bring back the status window so you can see what needs attention.

## Update without reconnecting your accounts

Updates add new connector code while keeping the existing installation's saved accounts, application settings, password, connector API key, and scheduled jobs. You authorize a new platform once after its connector becomes available. Existing platforms may request authorization again if access is revoked, refresh credentials expire, or a new action needs additional permissions.

1. In Connector, open **Settings → Updates and new connectors** and click **View Windows releases**. For an older version, [open Windows releases here](https://github.com/GiftedElephant1/connector/releases). Choose **Connector-Windows.zip** from a signed release. Developers can also use the [manual source update](#manual-source-update) below when installing directly from the repository.
2. Open **Downloads** in File Explorer. Right-click the downloaded ZIP, select **Extract All…**, and then **Extract**. Open the extracted **Connector** folder. Release assets have one ZIP layer; the automatically listed source archives are developer source, not the signed Windows package.
3. Keep the new download separate from your existing installation. Beside the Windows clock, click the **Show hidden icons** arrow if needed, right-click Connector's icon, and choose **Stop Connector**. If you are updating an older version without a tray icon, click **Stop Connector** in its small window. Closing the browser or hiding the current window does not stop the app. Scheduled actions pause while the app is stopped.
4. Open the **newly downloaded** folder containing **Update Connector.vbs** and double-click **Update Connector**.
5. Use the wizard's folder picker to select the **original Connector folder** you have been using. Choose the folder containing your existing **Start Connector** file, not the new download.
6. Start the update in the wizard and wait for it to finish. It installs and builds the new components before changing the old app files. Internet access is needed to download dependencies. Leave the update window open until it finishes.
7. When the wizard reports success, open Connector from the wizard or double-click **Start Connector** in your **original folder**. Your existing accounts and settings remain there. Connect any newly added platform from the dashboard.

The update wizard uses the private runtime installed by **Start Connector**. If it reports that the runtime is missing, start **Start Connector** from the new download once to install the runtime, stop it, and reopen **Update Connector** to update your original folder. Your existing accounts remain in the original folder. A computer with no existing installation should use **Start Connector** for its first setup.

The wizard leaves the original `.env` and account database in place; it does not reset keys or copy credentials into the new download. Keep those private files together if you back up or move an installation. If you configured a custom data folder, it is preserved; data stored inside an application-code folder must be moved out before the wizard can update safely.

The improved reopen behavior takes effect after you install the update on your PC. Downloading new files alone does not change a launcher that is already running. This update does not reset your connectors or require you to enter their developer credentials again.

Existing Connector API keys stay the same. Your AI connections continue to use their saved URL while your public address stays the same. If ngrok assigns a different address after restarting, copy the new URL from **AI connections** into each AI app and authorize its OAuth connection again. Your destination accounts remain saved.

The launcher uses port 3000 on your own PC. If another program uses that port, it shows a message and stops rather than taking over that program. Close the other program or previous Connector instance, then try again.

### Manual source update

A repository checkout can also be used as the new source folder for the update wizard. This installs and builds the source on your PC; it is separate from the signed Windows release package.

1. Install [Git for Windows](https://git-scm.com/downloads/win) if it is not already installed.
2. Open PowerShell and download a separate copy (choose a different destination if this folder already exists):

   ```powershell
   $connectorSourceUpdate = Join-Path $env:USERPROFILE 'Connector-source-update'
   git clone --branch main --single-branch https://github.com/GiftedElephant1/connector.git $connectorSourceUpdate
   ```

3. If your update instructions specify a commit, check it out in that source copy with `git -C $connectorSourceUpdate checkout --detach COMMIT_ID`, replacing `COMMIT_ID` with the supplied public commit identifier.
4. Back up your original installation privately, stop Connector using its tray menu, then open the new source folder and double-click **Update Connector.vbs**.
5. Choose your **original inner Connector folder** containing **Start Connector.vbs**, `.env`, and its saved data. Complete the wizard and restart from that original folder.

The wizard preserves the original configuration and saved connections using the same update process described above. Do not copy `.env`, encryption keys, or account databases into the source checkout or commit them to Git. A source update does not change Windows or browser security settings.

## Troubleshooting without a terminal

- **Chrome says “Dangerous download blocked”:** do not disable browser protection or force the blocked file to run. The older Windows packages are unsigned script launchers; the warning alone does not identify Google’s exact reason. A signed release must pass publisher verification and a malware scan before publication. If a signed release is still blocked, its exact download must be investigated and reported for review. See [download protection and release signing](windows-signing.md).

- **"Connector is already starting, updating, or needs attention":** older versions show this message when they detect an existing launcher or updater but cannot open its dashboard yet. It does not mean your accounts have been deleted or your login details are wrong. Click **OK**, look beside the Windows clock or under **Show hidden icons**, right-click Connector, and choose **Show status**. Follow the actual startup message there, or wait for an active update to finish. To install the fix, choose **Stop Connector** on the existing instance and follow the update steps above. If the existing instance cannot be found or is unresponsive, finish any active update first, save your other work, and restart Windows; then stop Connector if automatic startup launches it, and run the update wizard. Do not restart Windows while the updater is still working.
- **"Connector is already open":** the updated launcher could not reach the existing window. Click **Retry opening Connector** to try again, or **View status log** to see its latest startup messages. **Close** dismisses this recovery window without stopping the existing app or updater. If the original instance has exited, retrying can start Connector normally. Let any active update finish before restarting Windows as a last resort.
- **The app keeps using incorrect connection details:** use **Disable and reset** on that connector, review any shared connections listed, confirm, and select **Set up again**. This clears stored app credentials as well as account access. See [reset instructions](reset-connectors.md) for Google and AI connections too.
- **Nothing opens:** confirm you extracted the entire ZIP and are opening `Start Connector.vbs` from the extracted folder. Windows Script Host and Windows PowerShell must be available; an organization's device policies may restrict downloaded scripts. Ask that device's administrator about approved installation methods if it is blocked.
- **Setup cannot download components:** check your Internet connection and available disk space, then close the launcher and reopen it. It downloads only the runtime from `nodejs.org` and package dependencies using npm's configured registry.
- **A startup stage fails:** select **View status log**. The log identifies the failed stage without recording credentials or raw server output. It lives at `%LOCALAPPDATA%\Connector\launcher.log`.
- **The browser does not open:** right-click Connector's icon beside the clock and select **Open Connector**, or use that button in the startup window. Check your default browser settings.
- **The small window disappeared:** after startup, closing or minimizing that window hides it. Automatic Windows sign-in startup is hidden too. Look beside the Windows clock or under **Show hidden icons** for Connector, then choose **Show status** to bring it back.
- **Schedules are not running:** confirm Connector is running in the notification area and check your Internet connection and Windows sleep settings. No browser or launcher window needs to remain open.

## Maintainer notes

`scripts/package-windows.mjs` creates `artifacts/Connector-Windows.zip` and a SHA-256 checksum file. It includes application source and the launcher, and excludes local account storage, private environment files, dependencies, symbolic links, and build output. `Package Windows app` runs for pushes to `main` and can also be triggered manually. It validates PowerShell syntax, runs application checks on Windows, verifies the extracted package builds and preserves existing accounts, and scans the exact ZIP and extracted files. It uploads only the scan report and package checksum as **Windows-package-verification**, whether the scan passes or fails. The unsigned runnable ZIP stays on the build runner and is never included in that artifact. A failed scan still fails the workflow; a passed scan does not establish browser acceptance. The separate **Publish signed Windows release** workflow requires validated publisher credentials, verifies every script, scans the exact archive, and publishes reports alongside the release only after all gates pass. See [publisher setup and release instructions](windows-signing.md).

The launcher pins Node.js 24.13.0, verifies both the official archive checksum manifest and embedded SHA-256 expectations, and checks the runtime executable hash on later launches. Runtime files and npm's cache stay under `%LOCALAPPDATA%\Connector`; the app's private configuration and data stay in the extracted Connector folder. Downloads retain normal TLS certificate verification. No administrator permissions or system-wide runtime installation are requested.

Manual Windows validation should cover a fresh user profile, paths containing spaces/non-ASCII characters, x64 and ARM64, cancelled downloads, an occupied port, a second launch during startup, failure, and an active update, restart with saved accounts, hiding and reopening through the notification area, enabling/disabling sign-in startup, sign-out/shutdown, and Stop Connector during setup and normal operation. Include reopening an older launcher and opening Start Connector from a different download folder while the original installation is active. Confirm that scheduled actions and public access continue with both windows closed, that automatic startup opens no browser, that failures restore the status window, and that the updater refuses to run until Connector is stopped. A Linux-only build cannot establish that the native Windows launcher has passed these checks.
