#requires -Version 5.1
# Scan only a release ZIP and its private extracted copy. A scanner error, stale
# signatures, a detected/remediated threat, or an unavailable scanner is a failure.
param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)][string]$ReportPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ConnectorDefenderScanner {
    $status = Get-MpComputerStatus -ErrorAction Stop
    if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled -or
        -not $status.RealTimeProtectionEnabled -or $status.AMRunningMode -ne 'Normal') {
        throw 'Microsoft Defender must be active with real-time protection enabled.'
    }
    $preferences = Get-MpPreference -ErrorAction Stop
    if ($preferences.DisableArchiveScanning -or $preferences.DisableScriptScanning -or
        -not $preferences.DisableAutoExclusions) {
        throw 'Microsoft Defender archive/script scanning must be enabled and automatic server exclusions disabled.'
    }
    foreach ($property in @('ExclusionPath', 'ExclusionExtension', 'ExclusionProcess')) {
        if (@($preferences.$property | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count) {
            throw 'Microsoft Defender path, extension, and process exclusions must be empty for this release scan.'
        }
    }
    $updated = ([DateTime]$status.AntivirusSignatureLastUpdated).ToUniversalTime()
    $age = ([DateTime]::UtcNow - $updated).TotalHours
    if ($age -lt -1 -or $age -gt 48) {
        throw 'Microsoft Defender antivirus definitions must have been updated within the last 48 hours.'
    }
    $candidates = @()
    $platformRoot = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
    if (Test-Path -LiteralPath $platformRoot -PathType Container) {
        $candidates += @(Get-ChildItem -LiteralPath $platformRoot -Directory |
            Where-Object { $_.Name -like ($status.AMProductVersion + '*') } |
            Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' })
    }
    $candidates += Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
    $scanner = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $scanner) { throw 'The Microsoft Defender command-line scanner is unavailable.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $scanner -ErrorAction Stop
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
        $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
        throw 'The Microsoft Defender scanner does not have a valid Microsoft publisher signature.'
    }
    return @{
        Path = $scanner
        ProductVersion = [string]$status.AMProductVersion
        EngineVersion = [string]$status.AMEngineVersion
        SignatureVersion = [string]$status.AntivirusSignatureVersion
        SignatureUpdatedUtc = $updated.ToString('o')
        RealTimeProtectionEnabled = $true
        ArchiveScanningEnabled = $true
        ScriptScanningEnabled = $true
        ExclusionsEmpty = $true
    }
}

function Invoke-ConnectorDefenderCustomScan([string]$scanner, [string]$path) {
    # Windows file names cannot contain quotes. UseShellExecute=false avoids a
    # command shell; captured scanner output is never mistaken for a verdict.
    if ($path.Contains('"')) { throw 'The package scan path is invalid.' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $scanner
    # This custom-scan option suppresses remediation by this scan, not antivirus
    # protection. A detected threat cannot become a successful remediated result.
    # Real-time protection remains enabled and is checked before and after.
    $info.Arguments = '-Scan -ScanType 3 -DisableRemediation -File "' + $path + '"'
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
            if ([DateTime]::UtcNow -gt $deadline) {
                $process.Kill()
                throw 'Microsoft Defender did not complete its package scan within 15 minutes.'
            }
        }
        [void]$output.GetAwaiter().GetResult()
        [void]$errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Microsoft Defender reported a threat or could not complete the package scan.' }
        # Also check threat history in the caller: concurrent real-time detection
        # must not make a remediated/quarantined release look clean.
    } finally { $process.Dispose() }
}

function Get-ConnectorDefenderDetections {
    return @(Get-MpThreatDetection -ErrorAction Stop | ForEach-Object {
        [PSCustomObject]@{
            Id = [string]$_.DetectionID
            Changed = [string]$_.LastThreatStatusChangeTime
            ThreatId = [string]$_.ThreatID
            Resources = @($_.Resources | ForEach-Object { [string]$_ })
        }
    })
}

function Test-ConnectorDefenderDetection($detection, [string[]]$paths, [object[]]$previous) {
    foreach ($resource in $detection.Resources) {
        $normalized = $resource.Replace('/', '\')
        foreach ($path in $paths) {
            if ($normalized.IndexOf($path.Replace('/', '\'), [StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
        }
    }
    # A new/changed detection during this isolated release scan is ambiguous
    # even if Defender omits its resource path. Fail closed instead of guessing.
    return -not @($previous | Where-Object {
        $_.Id -ceq $detection.Id -and $_.Changed -ceq $detection.Changed -and $_.ThreatId -ceq $detection.ThreatId
    }).Count
}

function Expand-ConnectorScanArchive([string]$archivePath, [string]$destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $root = [IO.Path]::GetFullPath($destination).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or ($name.Split('/') -contains '..')) {
                throw 'The package ZIP contains an unsafe extraction path.'
            }
            # A UNIX symlink in a ZIP is not an application file.
            if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) {
                throw 'The package ZIP contains a symbolic link.'
            }
            $target = [IO.Path]::GetFullPath((Join-Path $destination $name))
            if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
                throw 'The package ZIP contains an unsafe extraction path.'
            }
            if ($name.EndsWith('/')) { [void][IO.Directory]::CreateDirectory($target); continue }
            [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target))
            [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
        }
    } finally { $archive.Dispose() }
}

function Invoke-ConnectorWindowsPackageScan([string]$package, [string]$reportPath) {
    $report = [ordered]@{
        schemaVersion = 1
        result = 'failed'
        packageFile = [IO.Path]::GetFileName($package)
        packageSha256 = $null
        startedUtc = [DateTime]::UtcNow.ToString('o')
        finishedUtc = $null
        scanner = $null
        scanned = @()
        detectedThreatCount = $null
        failure = $null
        limitations = 'A clean Microsoft Defender scan is not a guarantee of safety or acceptance by Chrome Safe Browsing or Windows SmartScreen.'
    }
    $scratch = $null
    $failure = $null
    $destination = [IO.Path]::GetFullPath($reportPath)
    $package = [IO.Path]::GetFullPath($package)
    if ([String]::Equals($destination, $package, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The scan report must not overwrite the package.'
    }
    try {
        if ($env:OS -ne 'Windows_NT') { throw 'The release scan requires Microsoft Defender on Windows.' }
        if ([IO.Path]::GetExtension($package) -ine '.zip' -or -not (Test-Path -LiteralPath $package -PathType Leaf)) {
            throw 'Select an existing release ZIP to scan.'
        }
        $report.packageSha256 = (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()
        $scanner = Get-ConnectorDefenderScanner
        $report.scanner = [ordered]@{
            name = 'Microsoft Defender Antivirus'
            productVersion = $scanner.ProductVersion
            engineVersion = $scanner.EngineVersion
            signatureVersion = $scanner.SignatureVersion
            signatureUpdatedUtc = $scanner.SignatureUpdatedUtc
            realTimeProtectionEnabled = $scanner.RealTimeProtectionEnabled
            archiveScanningEnabled = $scanner.ArchiveScanningEnabled
            scriptScanningEnabled = $scanner.ScriptScanningEnabled
            exclusionsEmpty = $scanner.ExclusionsEmpty
        }
        $previous = @(Get-ConnectorDefenderDetections)
        $tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
        $scratch = Join-Path $tempRoot ('connector-package-scan-' + [Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($scratch)
        Invoke-ConnectorDefenderCustomScan $scanner.Path $package
        $report.scanned += 'release-zip'
        Expand-ConnectorScanArchive $package $scratch
        Invoke-ConnectorDefenderCustomScan $scanner.Path $scratch
        $report.scanned += 'extracted-package'
        $detections = @(Get-ConnectorDefenderDetections | Where-Object {
            Test-ConnectorDefenderDetection $_ @($package, $scratch) $previous
        })
        $report.detectedThreatCount = $detections.Count
        if ($detections.Count -gt 0) { throw 'Microsoft Defender detected or remediated a threat during the package scan.' }
        if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $report.packageSha256) {
            throw 'The release ZIP changed during the scan.'
        }
        # Re-check that protection stayed active and the definitions stayed fresh.
        [void](Get-ConnectorDefenderScanner)
        $report.result = 'passed'
    } catch {
        $failure = $_
        # Exception messages from Windows can include local account/file names;
        # the public report deliberately contains only this fixed failure text.
        $report.failure = 'The scan could not establish a clean, unchanged package with active Microsoft Defender and current definitions. See the workflow step error.'
    } finally {
        $report.finishedUtc = [DateTime]::UtcNow.ToString('o')
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
        [IO.File]::WriteAllText($destination, ($report | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
        if ($scratch -and (Test-Path -LiteralPath $scratch)) { Remove-Item -LiteralPath $scratch -Recurse -Force }
    }
    if ($failure) { throw $failure }
    Write-Output ('Microsoft Defender scanned the ZIP and extracted package: ' + $report.packageSha256)
}

Invoke-ConnectorWindowsPackageScan $PackagePath $ReportPath
