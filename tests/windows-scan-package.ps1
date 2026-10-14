# Fixture checks only. These do not run Defender or establish a malware verdict.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$errors = $null
$tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $repository 'scripts/windows-scan-package.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'The package scan helper has syntax errors.' }
foreach ($definition in $ast.FindAll({ param($item) $item -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression $definition.Extent.Text
}
function Assert([bool]$condition, [string]$message) { if (-not $condition) { throw $message } }
function Assert-Rejected([scriptblock]$action, [string]$message) {
    $rejected = $false
    try { & $action } catch { $rejected = $true }
    Assert $rejected $message
}

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('connector-scan-fixtures-' + [Guid]::NewGuid().ToString('N'))
$oldEnvironment = @{}
foreach ($name in @('OS', 'ProgramData', 'ProgramFiles', 'RUNNER_TEMP', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT', 'RUNNER_OS')) { $oldEnvironment[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    [void][IO.Directory]::CreateDirectory($scratch)
    $env:GITHUB_ACTIONS = 'false'
    $guarded = $false
    try { & (Join-Path $repository '.github/scripts/prepare-windows-defender.ps1') }
    catch { $guarded = $_.Exception.Message.Contains('restricted to disposable GitHub-hosted Windows runners') }
    Assert $guarded 'Runner preparation did not reject a non-GitHub environment before changing settings.'
    $env:OS = 'Windows_NT'
    $env:ProgramData = $scratch
    $env:ProgramFiles = $scratch
    $env:RUNNER_TEMP = Join-Path $scratch 'temporary'
    [void][IO.Directory]::CreateDirectory($env:RUNNER_TEMP)
    $scannerPath = Join-Path $scratch 'Windows Defender/MpCmdRun.exe'
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($scannerPath))
    [IO.File]::WriteAllText($scannerPath, 'fixture: never execute')
    $script:status = [PSCustomObject]@{
        AMServiceEnabled = $true; AntivirusEnabled = $true; RealTimeProtectionEnabled = $true
        AMRunningMode = 'Normal'; AMProductVersion = 'fixture-product'; AMEngineVersion = 'fixture-engine'
        AntivirusSignatureVersion = 'fixture-definitions'; AntivirusSignatureLastUpdated = [DateTime]::UtcNow
    }
    function Get-MpComputerStatus { [CmdletBinding()]param() return $script:status }
    $script:preferences = [PSCustomObject]@{
        DisableArchiveScanning = $false; DisableScriptScanning = $false; DisableAutoExclusions = $true
        ExclusionPath = @(); ExclusionExtension = @(); ExclusionProcess = @()
    }
    function Get-MpPreference { [CmdletBinding()]param() return $script:preferences }
    $script:signature = [PSCustomObject]@{
        Status = 'Valid'; SignerCertificate = [PSCustomObject]@{ Subject = 'CN=Microsoft Windows Publisher, O=Microsoft Corporation, C=US' }
    }
    function Get-AuthenticodeSignature { [CmdletBinding()]param([string]$LiteralPath) return $script:signature }
    Assert ((Get-ConnectorDefenderScanner).EngineVersion -eq 'fixture-engine') 'Scanner metadata was not retained.'
    $script:status.AntivirusSignatureLastUpdated = [DateTime]::UtcNow.AddDays(-3)
    Assert-Rejected { Get-ConnectorDefenderScanner } 'Stale definitions were accepted.'
    $script:status.AntivirusSignatureLastUpdated = [DateTime]::UtcNow
    $script:status.RealTimeProtectionEnabled = $false
    Assert-Rejected { Get-ConnectorDefenderScanner } 'Disabled real-time protection was accepted.'
    $script:status.RealTimeProtectionEnabled = $true
    $script:preferences.DisableArchiveScanning = $true
    Assert-Rejected { Get-ConnectorDefenderScanner } 'Disabled archive scanning was accepted.'
    $script:preferences.DisableArchiveScanning = $false
    $script:preferences.DisableScriptScanning = $true
    Assert-Rejected { Get-ConnectorDefenderScanner } 'Disabled script scanning was accepted.'
    $script:preferences.DisableScriptScanning = $false
    $script:preferences.DisableAutoExclusions = $false
    Assert-Rejected { Get-ConnectorDefenderScanner } 'Automatic server exclusions were accepted.'
    $script:preferences.DisableAutoExclusions = $true
    foreach ($property in @('ExclusionPath', 'ExclusionExtension', 'ExclusionProcess')) {
        $script:preferences.$property = @('fixture-exclusion')
        Assert-Rejected { Get-ConnectorDefenderScanner } ('An exclusion was accepted: ' + $property)
        $script:preferences.$property = @()
    }
    $script:signature.Status = 'NotSigned'
    Assert-Rejected { Get-ConnectorDefenderScanner } 'An unsigned scanner was accepted.'
    $script:signature.Status = 'Valid'
    Remove-Item -LiteralPath $scannerPath
    Assert-Rejected { Get-ConnectorDefenderScanner } 'A missing scanner was accepted.'
    [IO.File]::WriteAllText($scannerPath, 'fixture: never execute')

    $package = Join-Path $scratch 'Connector-Windows.zip'
    $inputDirectory = Join-Path $scratch 'input'
    [void][IO.Directory]::CreateDirectory($inputDirectory)
    [IO.File]::WriteAllText((Join-Path $inputDirectory 'public-file.txt'), 'Public application fixture.')
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($inputDirectory, $package)
    $script:scans = New-Object 'System.Collections.Generic.List[string]'
    $script:scanFailure = $false
    $script:tamper = $false
    $script:history = @()
    $script:queryCount = 0
    $script:newDetection = $false
    function Invoke-ConnectorDefenderCustomScan([string]$scanner, [string]$path) {
        $script:scans.Add($path)
        if ($script:scanFailure) { throw 'Fixture scanner detected a threat or failed.' }
        if ($script:tamper -and (Test-Path -LiteralPath $path -PathType Container)) { [IO.File]::AppendAllText($package, 'tampered') }
    }
    function Get-MpThreatDetection {
        [CmdletBinding()]param()
        $script:queryCount++
        if ($script:newDetection -and $script:queryCount -gt 1) {
            return [PSCustomObject]@{ DetectionID = 'new'; LastThreatStatusChangeTime = 'later'; ThreatID = 'fixture-threat'; Resources = @('file:_' + $package) }
        }
        return $script:history
    }
    $report = Join-Path $scratch 'scan.json'
    Invoke-ConnectorWindowsPackageScan $package $report | Out-Null
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    Assert ($result.result -eq 'passed' -and $result.scanned.Count -eq 2 -and $result.detectedThreatCount -eq 0) 'A clean fixture did not complete both scans.'
    Assert ($result.packageSha256 -eq (Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant()) 'The report did not identify the exact ZIP.'
    Assert ($script:scans.Count -eq 2 -and $script:scans[0] -eq $package) 'The exact ZIP was not scanned first.'
    Assert (-not (Test-Path -LiteralPath $script:scans[1])) 'Private extracted scan files were not cleaned up.'

    $script:scanFailure = $true
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report } 'A scanner failure was reported as successful.'
    Assert ((Get-Content -LiteralPath $report -Raw | ConvertFrom-Json).result -eq 'failed') 'Scanner failure did not create a failed report.'
    $script:scanFailure = $false
    $script:newDetection = $true
    $script:queryCount = 0
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report } 'A detected/remediated threat was reported as clean.'
    Assert ((Get-Content -LiteralPath $report -Raw | ConvertFrom-Json).detectedThreatCount -eq 1) 'Detected threat evidence was lost.'
    $script:newDetection = $false
    $script:tamper = $true
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $report } 'A ZIP changed during its scan was accepted.'
    $script:tamper = $false
    Assert-Rejected { Invoke-ConnectorWindowsPackageScan $package $package } 'The scan report was allowed to overwrite the package.'

    $old = [PSCustomObject]@{ Id = 'old'; Changed = 'before'; ThreatId = 'fixture'; Resources = @('file:_C:\unrelated\file.txt') }
    Assert (-not (Test-ConnectorDefenderDetection $old @($package) @($old))) 'Unchanged unrelated history was treated as a new detection.'
    $changed = [PSCustomObject]@{ Id = 'old'; Changed = 'after'; ThreatId = 'fixture'; Resources = @() }
    Assert (Test-ConnectorDefenderDetection $changed @($package) @($old)) 'A changed detection without a resource path was ignored.'

    $malicious = Join-Path $scratch 'unsafe.zip'
    $zip = [IO.Compression.ZipFile]::Open($malicious, [IO.Compression.ZipArchiveMode]::Create)
    try { [void]$zip.CreateEntry('../escaped.txt') } finally { $zip.Dispose() }
    Assert-Rejected { Expand-ConnectorScanArchive $malicious (Join-Path $scratch 'extracted') } 'ZIP path traversal was accepted.'
    Assert (-not (Test-Path -LiteralPath (Join-Path $scratch 'escaped.txt'))) 'ZIP extraction wrote outside its private directory.'
    Write-Output 'Package scan fixture checks passed; no real antivirus scan was performed.'
} finally {
    foreach ($name in $oldEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $oldEnvironment[$name]) }
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
}
