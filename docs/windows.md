# Use Connector on Windows

Download the Windows ZIP, extract it, and double-click **Start Connector**. You do not need to install Node.js or Git, type terminal commands, or edit a configuration file for first launch. Windows 10/11 on x64 or ARM64 and an Internet connection are required.

## Download and start

1. Download **Connector-Windows.zip** from this repository's release assets, when a release is available. If you are testing an unpublished build, open GitHub **Actions → Package Windows app**, choose a successful run, and download its **Connector-Windows** artifact. Artifact downloads require signing into GitHub.
2. In File Explorer, right-click the downloaded ZIP and choose **Extract All**. If you downloaded an Actions artifact, it contains `Connector-Windows.zip`; extract that ZIP too.
3. Move the extracted **Connector** folder to a place you want to keep it, such as your Documents folder. Do not launch from inside the ZIP, a temporary preview, or a read-only folder.
4. Open the extracted **Connector** folder and double-click **Start Connector** (`Start Connector.vbs` if extensions are visible).
5. A small Connector window shows setup progress. On the first launch it downloads a private, checksum-verified Node.js runtime and installs the app components. This can take several minutes. Later launches reuse them.
6. Your default browser opens Connector automatically and signs you into this local desktop session. Keep the small Connector window open while using the app.
7. Follow the dashboard's connection setup. Configure required developer-app credentials in the dashboard, then choose **Connect account** and approve access on the provider's own site. Platforms still control eligibility, consent, business verification, API access, and approval.

The local app runs at `http://127.0.0.1:3000`. The launcher uses a private, short-lived browser sign-in handoff; it never puts your saved provider credentials into that address. A cloud AI service needs the dashboard's remote-access setup before it can reach an app running on your PC.

## Stop and reopen

- Choose **Open Connector** in the small window to reopen the dashboard.
- Choose **Stop Connector** or close that window to stop the app. Closing only the browser leaves the app running.
- Double-click **Start Connector** again next time. The launcher will not start a second copy if another launcher is already running.
- Keep your PC awake and online for scheduled actions and remote access. Scheduled work cannot execute while the app is stopped.

## Existing installations and updates

The launcher preserves an existing `.env` file and `data` folder. If you already have an installation, stop it first, back up those two items privately, and copy the new release's application files into your existing Connector folder. Keep `.env` and `data` together, including the existing encryption key. Do not commit or upload them to GitHub.

The launcher uses port 3000 on your own PC. If another program uses that port, it shows a message and stops rather than taking over that program. Close the other program or previous Connector instance, then try again.

## Troubleshooting without a terminal

- **Nothing opens:** confirm you extracted the entire ZIP and are opening `Start Connector.vbs` from the extracted folder. Windows Script Host and Windows PowerShell must be available; an organization's device policies may restrict downloaded scripts. Ask that device's administrator about approved installation methods if it is blocked.
- **Setup cannot download components:** check your Internet connection and available disk space, then close the launcher and reopen it. It downloads only the runtime from `nodejs.org` and package dependencies using npm's configured registry.
- **A startup stage fails:** select **View status log**. The log identifies the failed stage without recording credentials or raw server output. It lives at `%LOCALAPPDATA%\Connector\launcher.log`.
- **The browser does not open:** select **Open Connector** in the launcher window and check your default browser settings.
- **Schedules are not running:** leave the Connector window open and check Windows sleep settings.

## Maintainer notes

`scripts/package-windows.mjs` creates `artifacts/Connector-Windows.zip` and a SHA-256 checksum file. It includes application source and the launcher, and excludes local account storage, private environment files, dependencies, symbolic links, and build output. `Package Windows app` runs for pushes to `main` and can also be triggered manually. It validates PowerShell syntax, runs application checks on Windows, verifies the extracted package builds, and uploads the ZIP as an artifact. It does not automatically publish a GitHub release or claim the application is code-signed.

The launcher pins Node.js 24.13.0, verifies both the official archive checksum manifest and embedded SHA-256 expectations, and checks the runtime executable hash on later launches. Runtime files and npm's cache stay under `%LOCALAPPDATA%\Connector`; the app's private configuration and data stay in the extracted Connector folder. Downloads retain normal TLS certificate verification. No administrator permissions or system-wide runtime installation are requested.

Manual Windows validation should cover a fresh user profile, paths containing spaces/non-ASCII characters, x64 and ARM64, cancelled downloads, an occupied port, a second launch, restart with saved accounts, and Stop Connector during setup and normal operation. A Linux-only build cannot establish that the native Windows launcher has passed these checks.
