# This helper installs only the official 1Password CLI. Authentication and vault
# access are approved in the 1Password desktop app, never in this window.
[CmdletBinding()]
param([switch]$TestMode, [switch]$HideLaunchConsole)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
. (Join-Path $PSScriptRoot 'windows-background.ps1')
if ($HideLaunchConsole) { [void](Hide-ConnectorLaunchConsole) }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Find-OnePasswordCli {
    $command = Get-Command op.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    $candidates = @()
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\op.exe') }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles '1Password CLI\op.exe') }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
    }
    return $null
}

function Open-SetupAddress([string]$Address) {
    # Only fixed addresses owned by this helper may be opened.
    if ($Address -notin @('https://1password.com/downloads/windows/', 'https://www.1password.dev/cli/get-started/', 'onepassword://settings/developers', 'http://127.0.0.1:3000')) {
        throw 'Unknown setup address.'
    }
    try { Start-Process -FilePath $Address | Out-Null }
    catch { $script:status.Text = 'Windows could not open that page. Open 1Password manually, or use the official setup links in docs/onepassword.md.' }
}

$script:installer = $null
$script:form = New-Object System.Windows.Forms.Form
$script:form.Text = 'Set up 1Password for Connector'
$script:form.ClientSize = New-Object System.Drawing.Size(650, 460)
$script:form.StartPosition = 'CenterScreen'
$script:form.FormBorderStyle = 'FixedDialog'
$script:form.MaximizeBox = $false
$script:form.Font = New-Object System.Drawing.Font('Segoe UI', 10)

$heading = New-Object System.Windows.Forms.Label
$heading.Text = 'Use your saved 1Password credentials'
$heading.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$heading.Location = New-Object System.Drawing.Point(24, 20)
$heading.Size = New-Object System.Drawing.Size(600, 34)
$script:form.Controls.Add($heading)

$instructions = New-Object System.Windows.Forms.Label
$instructions.Text = "1. Install or open the 1Password desktop app and sign in there.`r`n2. Install 1Password CLI using the button below if it is missing.`r`n3. In 1Password, enable Windows Hello, then open Settings > Developer`r`n    and turn on Integrate with 1Password CLI.`r`n4. In Connector, open Settings > 1Password and select your credentials.`r`n`r`nApprove access in 1Password when prompted. This helper never asks for`r`nyour 1Password password, Secret Key, or saved account credentials."
$instructions.Location = New-Object System.Drawing.Point(24, 64)
$instructions.Size = New-Object System.Drawing.Size(602, 174)
$script:form.Controls.Add($instructions)

function Add-SetupButton([string]$Text, [int]$X, [int]$Y, [int]$Width, [scriptblock]$OnClick) {
    $button = New-Object System.Windows.Forms.Button
    $button.Text = $Text
    $button.Location = New-Object System.Drawing.Point($X, $Y)
    $button.Size = New-Object System.Drawing.Size($Width, 36)
    $button.Add_Click($OnClick)
    $script:form.Controls.Add($button)
    return $button
}

$null = Add-SetupButton 'Get 1Password desktop' 24 244 220 { Open-SetupAddress 'https://1password.com/downloads/windows/' }
$null = Add-SetupButton 'Open 1Password settings' 256 244 252 { Open-SetupAddress 'onepassword://settings/developers' }
$script:installButton = Add-SetupButton 'Install 1Password CLI' 24 290 220 {
    $winget = Get-Command winget.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $winget) {
        $script:status.Text = 'Windows Package Manager (winget) is unavailable. Use the official CLI setup guide below, then choose Check again.'
        return
    }
    try {
        $start = New-Object System.Diagnostics.ProcessStartInfo
        $start.FileName = $winget.Source
        $start.Arguments = 'install --id AgileBits.1Password.CLI --exact --source winget --scope user --accept-source-agreements --accept-package-agreements --disable-interactivity'
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $script:installer = [System.Diagnostics.Process]::Start($start)
        $script:installButton.Enabled = $false
        $script:checkButton.Enabled = $false
        $script:status.Text = 'Installing the official 1Password CLI with Windows Package Manager. Keep this window open; no vault is being accessed.'
        $script:timer.Start()
    } catch {
        $script:status.Text = 'Windows could not start the CLI installer. Use the official CLI setup guide below, then choose Check again.'
    }
}
$script:checkButton = Add-SetupButton 'Check again' 256 290 120 { Update-SetupStatus }
$null = Add-SetupButton 'Official CLI setup guide' 388 290 238 { Open-SetupAddress 'https://www.1password.dev/cli/get-started/' }

$script:status = New-Object System.Windows.Forms.Label
$script:status.Location = New-Object System.Drawing.Point(24, 340)
$script:status.Size = New-Object System.Drawing.Size(602, 62)
$script:form.Controls.Add($script:status)

$null = Add-SetupButton 'Open Connector' 24 412 180 { Open-SetupAddress 'http://127.0.0.1:3000' }
$null = Add-SetupButton 'Close' 516 412 110 { $script:form.Close() }

function Update-SetupStatus {
    if (Find-OnePasswordCli) {
        $script:installButton.Enabled = $false
        $script:status.Text = '1Password CLI is installed. Enable its integration in 1Password, then restart Connector if it was already running. Open Settings > 1Password to check access.'
    } else {
        $script:installButton.Enabled = $true
        $script:status.Text = '1Password CLI was not found. Choose Install 1Password CLI. This installs the official AgileBits.1Password.CLI package for your Windows user.'
    }
}

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 500
$script:timer.Add_Tick({
    if (-not $script:installer -or -not $script:installer.HasExited) { return }
    $script:timer.Stop()
    $exitCode = $script:installer.ExitCode
    $script:installer.Dispose()
    $script:installer = $null
    $script:checkButton.Enabled = $true
    if (Find-OnePasswordCli) { Update-SetupStatus }
    else {
        $script:installButton.Enabled = $true
        $script:status.Text = "The installer finished, but the CLI was not found (exit code $exitCode). Reopen this helper or follow the official CLI setup guide. Your Connector accounts were not changed."
    }
})
if (-not $TestMode) {
    Update-SetupStatus
    try { [void]$script:form.ShowDialog() }
    finally {
        # Closing the helper leaves an in-progress Windows Package Manager
        # installation running; it must not terminate an installer mid-change.
        $script:timer.Dispose()
        if ($script:installer) { $script:installer.Dispose() }
        $script:form.Dispose()
    }
}
