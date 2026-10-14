# Publishing a signed Windows release

Chrome's **Dangerous download blocked** warning is a browser safety decision. A ZIP containing unsigned script launchers can encounter reputation problems, but the warning alone does not identify the detected file or prove a false positive. Keep browser and antivirus protection enabled. A clean scan or a code signature cannot guarantee that Chrome will accept a download.

The normal **Package Windows app** workflow produces development artifacts. The separate, manually started **Publish signed Windows release** workflow signs the VBS launchers and every packaged PowerShell script, verifies the trusted signatures before and after ZIP creation, tests the app and account-preserving updater, scans the exact ZIP with Microsoft Defender, and publishes a new GitHub release only when all checks pass. It never substitutes a self-signed certificate or silently skips signing or scanning.

This is a signed-script distribution, not an MSI/MSIX installer. The ZIP and JavaScript source do not carry Authenticode signatures. Initial setup still downloads the pinned, checksum-verified Node runtime and installs the locked npm dependencies. The release's checksum and attached reports identify the archive that was verified.

## One-time publisher setup

An authorized representative of **Vectre Pay Inc** must complete the signing provider's identity verification. This requires an Azure subscription and may incur fees; adding the workflow does not create an account, complete verification, or buy a certificate.

1. Sign in to the [Azure portal](https://portal.azure.com/). Search for **Artifact Signing** (formerly Trusted Signing) and create a signing account in a supported region. Follow Microsoft's [setup instructions](https://learn.microsoft.com/azure/artifact-signing/quickstart) if the service is not yet enabled for the subscription.
2. Complete **Identity validations** for the business that will publish Connector. Use the business's legal identity and public contact details. Wait for approval.
3. Create a **Public Trust** certificate profile linked to the approved identity. Do not select a private-trust or test profile. Record the account name, certificate profile name, and regional HTTPS endpoint shown in the portal, such as `https://eus.codesigning.azure.net/`.
4. In **Microsoft Entra ID → App registrations**, create an application for this repository's release workflow. Record its **Application (client) ID** and **Directory (tenant) ID**. Record the Azure subscription ID separately.
5. In that app registration, open **Certificates & secrets → Federated credentials → Add credential**. Choose the GitHub Actions scenario, organization **GiftedElephant1**, repository **connector**, entity type **Branch**, and branch **main**. The subject must be `repo:GiftedElephant1/connector:ref:refs/heads/main`, and the audience must be `api://AzureADTokenExchange`. This uses GitHub OIDC; do not create or paste a client secret into the repository.
6. At the certificate profile's **Access control (IAM)**, assign that application's service principal the **Artifact Signing Certificate Profile Signer** role, scoped to the certificate profile. If the Azure subscription login cannot see the subscription, use Microsoft's [OIDC configuration guide](https://github.com/Azure/artifact-signing-action/blob/main/docs/OIDC.md) to complete the required access; do not grant subscription Owner merely to make signing work.
7. In GitHub, open **GiftedElephant1/connector → Settings → Secrets and variables → Actions → Variables**. Add these repository variables:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | Application (client) ID of the release app registration |
| `AZURE_TENANT_ID` | Directory (tenant) ID |
| `AZURE_SUBSCRIPTION_ID` | Azure subscription ID |
| `SIGNING_ENDPOINT` | Regional HTTPS endpoint from the signing account |
| `SIGNING_ACCOUNT` | Signing account name |
| `SIGNING_CERTIFICATE_PROFILE` | Approved Public Trust certificate profile name |

These identifiers are configuration, not private signing keys. The private signing key stays with Azure. Restrict repository write access and protect `main`: anyone able to alter and run its signing workflow can request a publisher signature. The workflow requests an OIDC token and GitHub release-write permission only for its release job.

## Publish a version

1. Commit the intended changes and the same new version in `package.json` and `package-lock.json` to `main`. Let the ordinary application and Windows checks pass.
2. Open **Actions → Publish signed Windows release → Run workflow**. Choose **main** and enter the exact version from `package.json`, without `v`.
3. The workflow checks all configuration and refuses any existing version tag or release before contacting the signing service. It runs native launcher/updater tests and the application tests and build.
4. The distribution is staged separately from the checkout. The staged launchers require signed PowerShell scripts; the signing action signs the staged `.vbs` and `.ps1` files with SHA-256 and a timestamp. No private key is downloaded.
5. Signature verification must pass on the staged files and on the extracted final ZIP. The extracted app must build and preserve fixture accounts during an update. Microsoft Defender must finish scanning the release archive with no detection; scanner unavailability or errors stop publication.
6. Open the resulting GitHub release and inspect its signature and Defender JSON reports. Confirm the publisher is the expected business, and distribute the **Connector-Windows.zip** release asset and its `.sha256` checksum together. No signed release is available until this workflow has completed successfully.

The signed scripts require Windows to trust their publisher. On first launch, a PowerShell window can show **Do you want to run software from this untrusted publisher?** Review the certificate's actual business name against the expected publisher in the release's signature report. If it matches **Vectre Pay Inc** and you trust this release, choose **Always run** to approve that publisher for subsequent starts. Do not approve an unknown or mismatched publisher. The console hides after Windows validates the signed launch scripts, leaving the usual app window or background tray icon. The app never installs a trusted-root certificate or approves a publisher automatically. Enterprise device policy may still prevent execution.

Releases and tags are never overwritten. Assets are uploaded to a draft first, and the release is made public only after upload succeeds. If publication fails after reserving the version tag, inspect the failure and use a new version for the next attempt. Existing local account data is unaffected by a failed GitHub release.

## If Chrome still blocks a verified release

Record the exact warning, GitHub release URL, and archive SHA-256. Inspect the release reports and reproduce the detection against those exact bytes. If security software identifies malware, stop distribution and investigate it. A maintainer can submit a suspected false positive to the relevant vendor's review process after reviewing the package; do not rename, password-protect, or repackage files to bypass detection.

Useful official references: [Azure Artifact Signing action](https://github.com/Azure/artifact-signing-action), [PowerShell script signing](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_signing), and [Microsoft security submission portal](https://www.microsoft.com/wdsi/filesubmission).
