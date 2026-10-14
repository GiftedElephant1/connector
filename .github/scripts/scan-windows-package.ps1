#requires -Version 5.1
# CI scanner only; never distributed with Connector or changes Windows security.
param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)][string]$ReportPath,
    [string]$DatabasePath = ''
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ConnectorClamAVSpecification {
    # This exact vendor ZIP was verified against its detached Cisco Talos GPG
    # signature using the vendor key at the pinned documentation commit below.
    # The digest is checked before extracting or executing any downloaded code.
    return @{
        Version = '1.5.4'
        Url = 'https://github.com/Cisco-Talos/clamav/releases/download/clamav-1.5.4/clamav-1.5.4.win.x64.zip'
        Sha256 = '0d9e0228b2674137ea1a2853566c98a0278ad52ab2582c3d6dbd75373848c395'
        SigningFingerprint = '5BADCA2665EF59DCF8A23D8B707F0DB480836771'
        KeySource = 'https://raw.githubusercontent.com/Cisco-Talos/clamav-documentation/88e34cf7c031213747c965f3c56ee854629dd7b7/src/manual/cisco-talos.gpg'
    }
}

function ConvertTo-ConnectorScanArgument([AllowEmptyString()][string]$value) {
    $quoted = New-Object System.Text.StringBuilder
    [void]$quoted.Append([char]34)
    $slashes = 0
    foreach ($character in $value.ToCharArray()) {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34) { [void]$quoted.Append([char]92, ($slashes * 2 + 1)) }
        else { [void]$quoted.Append([char]92, $slashes) }
        [void]$quoted.Append($character)
        $slashes = 0
    }
    [void]$quoted.Append([char]92, ($slashes * 2))
    [void]$quoted.Append([char]34)
    return $quoted.ToString()
}

function Invoke-ConnectorScanProcess([string]$executable, [string[]]$arguments) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $executable
    $info.Arguments = ($arguments | ForEach-Object { ConvertTo-ConnectorScanArgument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $deadline = [DateTime]::UtcNow.AddMinutes(15)
        while (-not $process.WaitForExit(1000)) {
            if ([DateTime]::UtcNow -gt $deadline) { $process.Kill(); throw 'A scanner operation exceeded 15 minutes.' }
        }
        return @{ ExitCode = $process.ExitCode; Output = $output.GetAwaiter().GetResult(); Error = $errors.GetAwaiter().GetResult() }
    } finally { $process.Dispose() }
}

function Get-ConnectorScanDiagnostic($result) {
    # Only vendor status output for public CI files is captured; no credentials
    # are supplied to these tools. Bound the tail for readable workflow errors.
    $text = ([string]$result.Output + "`n" + [string]$result.Error).Trim()
    if ($text.Length -gt 1200) { $text = $text.Substring($text.Length - 1200) }
    return $text
}

function Expand-ConnectorScanArchive([string]$archivePath, [string]$destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $root = [IO.Path]::GetFullPath($destination).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        [long]$size = 0
        if ($archive.Entries.Count -gt 100000) { throw 'The ZIP contains too many files.' }
        foreach ($entry in $archive.Entries) {
            $size += $entry.Length
            if ($size -gt 4GB -or $entry.Length -gt 1GB) { throw 'The ZIP exceeds the permitted extraction size.' }
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..')) {
                throw 'The ZIP contains an unsafe extraction path.'
            }
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'The ZIP contains a symbolic link.' }
            $target = [IO.Path]::GetFullPath((Join-Path $destination $name))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'The ZIP contains an unsafe extraction path.' }
            if ($name.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($target); continue }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $archive.Dispose() }
}

function Install-ConnectorScanEngine([string]$scratch, $specification) {
    $archive = Join-Path $scratch 'official-clamav.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $specification.Url -OutFile $archive -UseBasicParsing -TimeoutSec 300 -ErrorAction Stop
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $specification.Sha256) {
        throw 'The official scanner download does not match its pinned verified SHA-256.'
    }
    $runtime = Join-Path $scratch 'engine'
    Expand-ConnectorScanArchive $archive $runtime
    $engine = Join-Path $runtime ('clamav-' + $specification.Version + '.win.x64')
    foreach ($file in @('clamscan.exe', 'freshclam.exe', 'sigtool.exe', 'certs/clamav.crt')) {
        if (-not (Test-Path -LiteralPath (Join-Path $engine $file) -PathType Leaf)) { throw 'The verified scanner package is incomplete.' }
    }
    return $engine
}

function Update-ConnectorScanDatabases([string]$engine, [string]$database, [string]$scratch) {
    [void][IO.Directory]::CreateDirectory($database)
    $configuration = Join-Path $scratch 'freshclam.conf'
    [IO.File]::WriteAllText($configuration, "DatabaseMirror database.clamav.net`nTestDatabases yes`nBytecode yes`nConnectTimeout 30`nReceiveTimeout 120`nMaxAttempts 2`n", (New-Object System.Text.UTF8Encoding($false)))
    $result = Invoke-ConnectorScanProcess (Join-Path $engine 'freshclam.exe') @('--stdout', ('--config-file=' + $configuration), ('--datadir=' + $database), ('--cvdcertsdir=' + (Join-Path $engine 'certs')))
    if ($result.ExitCode -ne 0) { throw ('FreshClam could not update and verify the official databases (exit ' + $result.ExitCode + '). ' + (Get-ConnectorScanDiagnostic $result)) }
}

function Get-ConnectorScanDatabaseMetadata([string]$engine, [string]$database) {
    $metadata = @()
    foreach ($name in @('main', 'daily', 'bytecode')) {
        $files = @(Get-ChildItem -LiteralPath $database -File | Where-Object { $_.Name -eq ($name + '.cvd') -or $_.Name -eq ($name + '.cld') })
        if ($files.Count -ne 1) { throw ('Exactly one official ' + $name + ' database is required.') }
        $file = $files[0]
        $verification = Invoke-ConnectorScanProcess (Join-Path $engine 'sigtool.exe') @(('--info=' + $file.FullName), ('--cvdcertsdir=' + (Join-Path $engine 'certs')))
        if ($verification.ExitCode -ne 0 -or $verification.Output -notmatch 'Verification OK\.') {
            throw ('Official database signature/integrity verification failed: ' + $name + '. ' + (Get-ConnectorScanDiagnostic $verification))
        }
        $stream = [IO.File]::OpenRead($file.FullName)
        try {
            $bytes = New-Object byte[] 512
            if ($stream.Read($bytes, 0, 512) -ne 512) { throw 'The database header is incomplete.' }
        } finally { $stream.Dispose() }
        $header = [Text.Encoding]::ASCII.GetString($bytes).Trim().Split(':')
        if ($header.Length -lt 9 -or $header[0] -cne 'ClamAV-VDB' -or $header[2] -notmatch '^\d+$' -or
            $header[3] -notmatch '^\d+$' -or [long]$header[3] -lt 1 -or $header[8] -notmatch '^\d+$') {
            throw 'The official database metadata is invalid or empty.'
        }
        $built = [DateTimeOffset]::FromUnixTimeSeconds([long]$header[8]).UtcDateTime
        $age = ([DateTime]::UtcNow - $built).TotalHours
        # Main and bytecode publish less frequently. Daily is the freshness gate.
        if ($age -lt -1 -or ($name -eq 'daily' -and $age -gt 48)) { throw 'The daily virus database is stale or has an invalid build time.' }
        $metadata += [ordered]@{
            name = $file.Name; version = [long]$header[2]; signatures = [long]$header[3]
            builtUtc = $built.ToString('o'); ageHours = [Math]::Round($age, 2)
            sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            verification = 'sigtool: Verification OK'
        }
    }
    return $metadata
}

function Invoke-ConnectorClamScan([string]$engine, [string]$database, [string]$target) {
    $result = Invoke-ConnectorScanProcess (Join-Path $engine 'clamscan.exe') @(
        ('--database=' + $database), ('--cvdcertsdir=' + (Join-Path $engine 'certs')),
        '--official-db-only=yes', '--fail-if-cvd-older-than=2', '--recursive=yes', '--infected',
        '--scan-archive=yes', '--alert-exceeds-max=yes', '--alert-encrypted=yes', '--max-filesize=128M', '--max-scansize=512M', $target
    )
    if ($result.ExitCode -ne 0) { throw ('ClamAV detected a threat or could not complete the scan (exit ' + $result.ExitCode + '). ' + (Get-ConnectorScanDiagnostic $result)) }
    $match = [regex]::Match($result.Output, '(?m)^Scanned files:\s+([1-9]\d*)\s*$')
    if (-not $match.Success -or $result.Output -notmatch '(?m)^Infected files:\s+0\s*$') {
        throw ('ClamAV did not report a complete, nonempty clean scan. ' + (Get-ConnectorScanDiagnostic $result))
    }
    return [long]$match.Groups[1].Value
}

function Get-ConnectorExtractedSnapshot([string]$directory) {
    return (@(Get-ChildItem -LiteralPath $directory -File -Recurse | Sort-Object FullName | ForEach-Object {
        $_.FullName + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    }) -join "`n")
}

function Invoke-ConnectorWindowsPackageScan([string]$package, [string]$reportPath, [string]$databasePath = '') {
    $package = [IO.Path]::GetFullPath($package)
    $destination = [IO.Path]::GetFullPath($reportPath)
    if ([String]::Equals($destination, $package, [StringComparison]::OrdinalIgnoreCase)) { throw 'The scan report must not overwrite the package.' }
    $report = [ordered]@{
        schemaVersion = 2; result = 'failed'; packageFile = [IO.Path]::GetFileName($package); packageSha256 = $null
        startedUtc = [DateTime]::UtcNow.ToString('o'); finishedUtc = $null; stage = 'validate-input'; scanner = $null
        databases = @(); scanned = @(); detectedThreatCount = $null; failure = $null
        limitations = 'A clean ClamAV scan is independent antivirus evidence, not a guarantee of safety or acceptance by Chrome Safe Browsing or Windows SmartScreen.'
    }
    $scratch = $null
    $failure = $null
    try {
        if ($env:OS -cne 'Windows_NT') { throw 'This CI scanner requires 64-bit Windows.' }
        if ([IO.Path]::GetExtension($package) -ine '.zip' -or -not (Test-Path -LiteralPath $package -PathType Leaf)) { throw 'Select an existing release ZIP.' }
        $report.packageSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
        $tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
        $scratch = Join-Path $tempRoot ('connector-package-scan-' + [Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($scratch)
        $database = if ($databasePath) { [IO.Path]::GetFullPath($databasePath) } else { Join-Path $scratch 'database' }
        $report.stage = 'verify-scanner-download'
        $specification = Get-ConnectorClamAVSpecification
        $engine = Install-ConnectorScanEngine $scratch $specification
        $version = Invoke-ConnectorScanProcess (Join-Path $engine 'clamscan.exe') @('--version')
        if ($version.ExitCode -ne 0 -or $version.Output.Trim() -notmatch ('^ClamAV ' + [regex]::Escape($specification.Version) + '(?:/|$)')) { throw 'The pinned scanner did not report its expected version.' }
        $report.scanner = [ordered]@{
            name = 'ClamAV'; engineVersion = $specification.Version; vendorUrl = $specification.Url
            verifiedDownloadSha256 = $specification.Sha256; releaseSigningFingerprint = $specification.SigningFingerprint
            releaseKeySource = $specification.KeySource; downloadVerification = 'Pinned SHA-256; vendor detached GPG signature verified when pinning this release'
        }
        $report.stage = 'update-official-databases'
        Update-ConnectorScanDatabases $engine $database $scratch
        $report.stage = 'verify-official-databases'
        $report.databases = @(Get-ConnectorScanDatabaseMetadata $engine $database)
        $report.stage = 'scan-release-zip'
        $count = Invoke-ConnectorClamScan $engine $database $package
        $report.scanned += [ordered]@{ target = 'release-zip'; files = $count }
        $report.stage = 'extract-release-zip'
        $extracted = Join-Path $scratch 'package'
        Expand-ConnectorScanArchive $package $extracted
        $snapshot = Get-ConnectorExtractedSnapshot $extracted
        if (-not $snapshot) { throw 'The release ZIP contains no files.' }
        $report.stage = 'scan-extracted-package'
        $count = Invoke-ConnectorClamScan $engine $database $extracted
        $report.scanned += [ordered]@{ target = 'extracted-package'; files = $count }
        $report.stage = 'verify-unchanged-inputs'
        if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -cne $report.packageSha256 -or
            (Get-ConnectorExtractedSnapshot $extracted) -cne $snapshot) { throw 'The ZIP or extracted files changed during scanning.' }
        foreach ($metadata in $report.databases) {
            if ((Get-FileHash -LiteralPath (Join-Path $database $metadata.name) -Algorithm SHA256).Hash.ToLowerInvariant() -cne $metadata.sha256) { throw 'A verified signature database changed during scanning.' }
        }
        $report.result = 'passed'; $report.stage = 'complete'; $report.detectedThreatCount = 0
    } catch {
        $failure = $_
        $report.failure = 'A verified scanner and current official databases could not establish a complete clean scan of the unchanged package. See the failed stage and workflow error.'
    } finally {
        $report.finishedUtc = [DateTime]::UtcNow.ToString('o')
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        [IO.File]::WriteAllText($destination, ($report | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
        if ($scratch -and (Test-Path -LiteralPath $scratch)) { Remove-Item -LiteralPath $scratch -Recurse -Force }
    }
    if ($failure) { throw ('Package scan failed at ' + $report.stage + ': ' + $failure.Exception.Message) }
    Write-Output ('ClamAV scanned the exact ZIP and extracted package: ' + $report.packageSha256)
}

Invoke-ConnectorWindowsPackageScan $PackagePath $ReportPath $DatabasePath
