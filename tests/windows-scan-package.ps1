# Fixture checks only. No scanner is downloaded and no real antivirus verdict is claimed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$errors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repository '.github/scripts/scan-windows-package.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The package scan helper has syntax errors.' }
foreach ($definition in $ast.FindAll({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) { Invoke-Expression $definition.Extent.Text }
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Assert-Rejected([scriptblock]$action, [string]$message) {
    $rejected = $false
    try { & $action } catch { $rejected = $true }
    Assert $rejected $message
}
function Write-FixtureDatabase([string]$file, [long]$timestamp, [long]$count = 42) {
    $header = 'ClamAV-VDB:fixture:123:' + $count + ':90:hash:signature:fixture:' + $timestamp
    [IO.File]::WriteAllText($file, $header.PadRight(512, ' ') + 'fixture contents', [Text.Encoding]::ASCII)
}
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('connector-scan-fixtures-' + [Guid]::NewGuid().ToString('N'))
$oldOS = $env:OS
$oldTemp = $env:RUNNER_TEMP
try {
    [void][IO.Directory]::CreateDirectory($temporary)
    $package = Join-Path $temporary 'Connector-Windows.zip'
    $inputDirectory = Join-Path $temporary 'input'
    [void][IO.Directory]::CreateDirectory($inputDirectory)
    [IO.File]::WriteAllText((Join-Path $inputDirectory 'public-file.txt'), 'Public application fixture.')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($inputDirectory, $package)
    $report = Join-Path $temporary 'scan.json'
    $env:OS = 'Linux'
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report } 'A non-Windows scanner run was accepted.'
    Assert ((Get-Content -LiteralPath $report -Raw | ConvertFrom-Json).stage -eq 'validate-input') 'Unsupported platform did not report its stage.'
    $env:OS = 'Windows_NT'
    $env:RUNNER_TEMP = Join-Path $temporary 'scratch'
    [void][IO.Directory]::CreateDirectory($env:RUNNER_TEMP)
    function Invoke-WebRequest {
        [CmdletBinding()]param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing, [int]$TimeoutSec)
        [IO.File]::WriteAllText($OutFile, 'substituted scanner archive')
    }
    Assert-Rejected { Install-ConnectorScanEngine $temporary (Get-ConnectorClamAVSpecification) } 'A scanner download with the wrong SHA-256 was accepted.'
    $script:engineFixture = Join-Path $temporary 'engine'
    [void][IO.Directory]::CreateDirectory($script:engineFixture)
    function Install-ConnectorScanEngine([string]$scratch, $specification) { return $script:engineFixture }
    $database = Join-Path $temporary 'database'
    [void][IO.Directory]::CreateDirectory($database)
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    foreach ($name in @('main', 'daily', 'bytecode')) { Write-FixtureDatabase (Join-Path $database ($name + '.cvd')) $timestamp }
    $script:scanTargets = New-Object 'System.Collections.Generic.List[string]'
    $script:scanExitCode = 0
    $script:freshclamExitCode = 0
    $script:sigtoolExitCode = 0
    $script:emptyScan = $false
    $script:tamperZip = $false
    $script:tamperExtracted = $false
    $script:tamperDatabase = $false
    $script:wrongVersion = $false
    function Invoke-ConnectorScanProcess([string]$executable, [string[]]$arguments) {
        $name = [IO.Path]::GetFileName($executable)
        if ($name -eq 'freshclam.exe') {
            Assert (@($arguments | Where-Object { $_ -like '--cvdcertsdir=*' }).Count -eq 1) 'FreshClam did not use the vendor certificates.'
            return @{ ExitCode = $script:freshclamExitCode; Output = 'Fixture update'; Error = '' }
        }
        if ($name -eq 'sigtool.exe') { return @{ ExitCode = $script:sigtoolExitCode; Output = 'Verification OK.'; Error = '' } }
        if ($arguments -contains '--version') {
            $version = if ($script:wrongVersion) { 'ClamAV 0.1' } else { 'ClamAV 1.5.4' }
            return @{ ExitCode = 0; Output = $version; Error = '' }
        }
        foreach ($required in @('--official-db-only=yes', '--fail-if-cvd-older-than=2', '--recursive=yes', '--scan-archive=yes', '--alert-exceeds-max=yes', '--alert-encrypted=yes')) {
            Assert ($arguments -contains $required) ('A required scan option was omitted: ' + $required)
        }
        $target = $arguments[-1]
        $script:scanTargets.Add($target)
        if (Test-Path -LiteralPath $target -PathType Container) {
            if ($script:tamperZip) { [IO.File]::AppendAllText($package, 'tampered') }
            if ($script:tamperExtracted) { [IO.File]::AppendAllText((Join-Path $target 'public-file.txt'), 'tampered') }
            if ($script:tamperDatabase) { [IO.File]::AppendAllText((Join-Path $database 'daily.cvd'), 'tampered') }
        }
        $count = if ($script:emptyScan) { 0 } else { 1 }
        return @{ ExitCode = $script:scanExitCode; Output = "Scanned files: $count`nInfected files: 0`n"; Error = '' }
    }
    Invoke-ConnectorWindowsPackageScan $package $report $database | Out-Null
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    Assert ($result.result -eq 'passed' -and $result.scanner.name -eq 'ClamAV' -and $result.scanned.Count -eq 2) 'A clean fixture did not complete both scans.'
    Assert ($result.databases.Count -eq 3 -and $result.detectedThreatCount -eq 0) 'Verified database metadata was lost.'
    Assert ($result.packageSha256 -eq (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()) 'The report did not identify the exact ZIP.'
    Assert ($script:scanTargets.Count -eq 2 -and $script:scanTargets[0] -eq $package) 'The exact ZIP was not scanned first.'
    Assert (-not (Test-Path -LiteralPath $script:scanTargets[1])) 'Private extracted files were not cleaned up.'
    Assert (Test-Path -LiteralPath $database) 'The reusable database cache was removed.'
    foreach ($exitCode in @(1, 2)) {
        $script:scanExitCode = $exitCode
        Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'A scanner detection/error was reported as clean.'
        $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
        Assert ($result.result -eq 'failed' -and $result.stage -eq 'scan-release-zip') 'A scanner failure did not identify its stage.'
    }
    $script:scanExitCode = 0
    $script:emptyScan = $true
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'An empty scan was accepted.'
    $script:emptyScan = $false
    $script:freshclamExitCode = 17
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'A failed database update was accepted.'
    $script:freshclamExitCode = 0
    $script:sigtoolExitCode = 1
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'Invalid database signatures were accepted.'
    $script:sigtoolExitCode = 0
    $script:wrongVersion = $true
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'An unexpected engine version was accepted.'
    $script:wrongVersion = $false
    Write-FixtureDatabase (Join-Path $database 'daily.cvd') ($timestamp - 3 * 86400)
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'Stale daily signatures were accepted.'
    Write-FixtureDatabase (Join-Path $database 'daily.cvd') ($timestamp + 86400)
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'Future-dated signatures were accepted.'
    Write-FixtureDatabase (Join-Path $database 'daily.cvd') $timestamp 0
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } 'An empty signature database was accepted.'
    Write-FixtureDatabase (Join-Path $database 'daily.cvd') $timestamp
    Write-FixtureDatabase (Join-Path $database 'main.cvd') ($timestamp - 100 * 86400)
    Invoke-ConnectorWindowsPackageScan $package $report $database | Out-Null
    Assert ((Get-Content -LiteralPath $report -Raw | ConvertFrom-Json).result -eq 'passed') 'A valid older main database was mistaken for stale daily signatures.'
    foreach ($variable in @('tamperZip', 'tamperExtracted', 'tamperDatabase')) {
        Set-Variable -Name $variable -Value $true -Scope Script
        Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report $database } ('Changed inputs were accepted: ' + $variable)
        Set-Variable -Name $variable -Value $false -Scope Script
    }
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $package $database } 'A scan report could overwrite the package.'
    $malicious = Join-Path $temporary 'unsafe.zip'
    $zip = [IO.Compression.ZipFile]::Open($malicious, [IO.Compression.ZipArchiveMode]::Create)
    try { [void]$zip.CreateEntry('../escaped.txt') } finally { $zip.Dispose() }
    Assert-Rejected { Expand-ConnectorScanArchive $malicious (Join-Path $temporary 'extracted') } 'ZIP path traversal was accepted.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $temporary 'escaped.txt'))) 'ZIP extraction wrote outside its private directory.'
    Write-Output 'ClamAV package scan fixture checks passed; no real antivirus scan was performed.'
} finally {
    $env:OS = $oldOS
    $env:RUNNER_TEMP = $oldTemp
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
