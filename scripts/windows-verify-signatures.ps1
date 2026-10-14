# Release gate: verify using the Windows trust store, never install certificates.
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$ReportPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath $Path).Path
foreach ($required in @('Start Connector.vbs', 'Update Connector.vbs', 'scripts/windows-launcher.ps1', 'scripts/windows-update.ps1', 'scripts/windows-common.ps1', 'scripts/windows-background.ps1')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $required) -PathType Leaf)) { throw "Required release script missing: $required" }
}
foreach ($launcher in @('Start Connector.vbs', 'Update Connector.vbs')) {
    $contents = Get-Content -LiteralPath (Join-Path $root $launcher) -Raw
    if ($contents -notmatch '-ExecutionPolicy AllSigned -WindowStyle Normal' -or
        $contents -notmatch '-HideLaunchConsole' -or $contents -notmatch 'shell.Run\(command, 1, False\)' -or
        $contents -match '-ExecutionPolicy Bypass') {
        throw "Release launcher must show publisher approval and enforce AllSigned: $launcher"
    }
}
$publisher = $null
$records = @()
$files = @(Get-ChildItem -LiteralPath $root -Recurse -File | Where-Object { $_.Extension -in @('.ps1', '.vbs') })
foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw "Invalid or missing publisher signature: $($file.Name) ($($signature.Status))" }
    $certificate = $signature.SignerCertificate
    if ($certificate.Subject -eq $certificate.Issuer) { throw "Self-signed publishers are not accepted: $($file.Name)" }
    $codeSigning = @($certificate.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.37' } |
        ForEach-Object { $_.EnhancedKeyUsages } | Where-Object { $_.Value -eq '1.3.6.1.5.5.7.3.3' })
    if ($codeSigning.Count -eq 0) { throw "A code-signing certificate is required: $($file.Name)" }
    if (-not $signature.TimeStamperCertificate) { throw "A trusted signing timestamp is required: $($file.Name)" }
    if ($null -eq $publisher) { $publisher = $certificate.Subject }
    if ($certificate.Subject -ne $publisher) { throw "Release scripts must share one verified publisher: $($file.Name)" }
    $records += [ordered]@{
        file = $file.FullName.Substring($root.TrimEnd('\', '/').Length + 1).Replace('\', '/')
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        publisher = $certificate.Subject
        thumbprint = $certificate.Thumbprint
        status = [string]$signature.Status
        timestampPublisher = $signature.TimeStamperCertificate.Subject
    }
}
if ($ReportPath) {
    $report = [ordered]@{ verifiedAtUtc = [DateTime]::UtcNow.ToString('o'); publisher = $publisher; files = $records }
    $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}
Write-Output "Verified $($files.Count) signed scripts from $publisher. No certificates or trust settings were changed."
