#requires -Version 5.1
# CI ONLY. This file is excluded from Connector downloads. It strengthens the
# disposable hosted runner; it must never change antivirus settings on a user's PC.
# GitHub's image builder deliberately disables Defender and excludes C:\ and D:\:
# https://github.com/actions/runner-images/blob/2c421200c9e6873283a7b1d63bb122bc906139a1/images/windows/scripts/build/Configure-WindowsDefender.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or
    $env:RUNNER_OS -cne 'Windows' -or $env:OS -cne 'Windows_NT') {
    throw 'Defender preparation is restricted to disposable GitHub-hosted Windows runners. No settings were changed.'
}

foreach ($command in @('Get-MpComputerStatus', 'Get-MpPreference', 'Set-MpPreference', 'Remove-MpPreference', 'Update-MpSignature')) {
    [void](Get-Command $command -ErrorAction Stop)
}
$service = Get-Service -Name WinDefend -ErrorAction Stop
if ($service.Status -ne 'Running') {
    if ($service.StartType -eq 'Disabled') { Set-Service -Name WinDefend -StartupType Automatic -ErrorAction Stop }
    Start-Service -Name WinDefend -ErrorAction Stop
    $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(30))
}

# Preserve every security control; enable the protections disabled by the base
# image. DisableAutoExclusions=true means automatic server exclusions are OFF.
Set-MpPreference -DisableRealtimeMonitoring $false -DisableArchiveScanning $false `
    -DisableScriptScanning $false -DisableIOAVProtection $false -DisableBehaviorMonitoring $false `
    -DisableAutoExclusions $true -ErrorAction Stop
$preferences = Get-MpPreference -ErrorAction Stop
foreach ($property in @('ExclusionPath', 'ExclusionExtension', 'ExclusionProcess')) {
    $values = @($preferences.$property | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) })
    if ($values.Count) {
        $parameters = @{ ErrorAction = 'Stop' }
        $parameters[$property] = $values
        Remove-MpPreference @parameters
    }
}

Write-Output 'Updating Microsoft Defender definitions on the disposable GitHub-hosted runner.'
Update-MpSignature -UpdateSource MicrosoftUpdateServer -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
    $status = Get-MpComputerStatus -ErrorAction Stop
    if ($status.AMServiceEnabled -and $status.AntivirusEnabled -and
        $status.RealTimeProtectionEnabled -and $status.AMRunningMode -eq 'Normal') { break }
    Start-Sleep -Seconds 1
} while ([DateTime]::UtcNow -lt $deadline)

if (-not $status.AMServiceEnabled -or -not $status.AntivirusEnabled -or
    -not $status.RealTimeProtectionEnabled -or $status.AMRunningMode -ne 'Normal') {
    throw 'The hosted runner could not activate Microsoft Defender in Normal mode. Use a fresh runner with active Defender; passive-mode or reboot requirements must not be bypassed.'
}
$preferences = Get-MpPreference -ErrorAction Stop
if ($preferences.DisableRealtimeMonitoring -or $preferences.DisableArchiveScanning -or
    $preferences.DisableScriptScanning -or -not $preferences.DisableAutoExclusions) {
    throw 'Required Microsoft Defender scanning protections did not remain enabled.'
}
foreach ($property in @('ExclusionPath', 'ExclusionExtension', 'ExclusionProcess')) {
    if (@($preferences.$property | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }).Count) {
        throw 'The disposable hosted runner still has antivirus exclusions. The package scan must not proceed.'
    }
}
$age = ([DateTime]::UtcNow - ([DateTime]$status.AntivirusSignatureLastUpdated).ToUniversalTime()).TotalHours
if ($age -lt -1 -or $age -gt 48) { throw 'Microsoft Defender definitions remain stale after the update.' }
Write-Output 'Microsoft Defender is active, archive/script scanning is enabled, exclusions are removed, and definitions are current.'
