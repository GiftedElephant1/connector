# Exercise the actual setup window without installing packages or accessing a vault.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/windows-onepassword-setup.ps1') -TestMode

try {
    function Find-OnePasswordCli { return $null }
    Update-SetupStatus
    if (-not $script:installButton.Enabled -or $script:status.Text -notmatch 'was not found') {
        throw 'A missing CLI must enable installation and explain the next step.'
    }
    function Find-OnePasswordCli { return 'C:\fixture\op.exe' }
    Update-SetupStatus
    if ($script:installButton.Enabled -or $script:status.Text -notmatch 'restart Connector') {
        throw 'An existing CLI must preserve the installation and explain restarting Connector.'
    }
    if (@($script:form.Controls | Where-Object { $_ -is [System.Windows.Forms.TextBox] }).Count -ne 0) {
        throw 'The setup helper must not request secret values.'
    }
    $rejected = $false
    try { Open-SetupAddress 'https://unexpected.example/' } catch { $rejected = $true }
    if (-not $rejected) { throw 'The setup helper must reject unknown launch addresses.' }
    Write-Output '1Password setup window and installed/missing CLI behavior passed without vault access.'
} finally {
    $script:timer.Dispose()
    $script:form.Dispose()
}
