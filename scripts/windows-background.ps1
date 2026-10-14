# Background launcher helpers. Compatible with Windows PowerShell 5.1.
# Closing the status window only hides a fully running instance. Windows logoff,
# shutdown, setup cancellation and explicit Stop must still release its child job.
function Get-ConnectorCloseAction([string]$phase, [string]$reason, [bool]$stopRequested = $false) {
    if ($phase -eq 'Running' -and $reason -eq 'UserClosing' -and -not $stopRequested) { return 'Hide' }
    return 'Stop'
}

function Get-ConnectorStartupPath([string]$startupDirectory = '') {
    if (-not $startupDirectory) { $startupDirectory = [Environment]::GetFolderPath('Startup') }
    if (-not $startupDirectory) { throw 'Windows could not find your personal Startup folder.' }
    return Join-Path $startupDirectory 'Connector Background.lnk'
}

function Get-ConnectorStartWithWindows([string]$root, [string]$startupDirectory = '') {
    $shortcutPath = Get-ConnectorStartupPath $startupDirectory
    if (-not (Test-Path -LiteralPath $shortcutPath)) { return $false }
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        try {
            $expectedTarget = Join-Path $env:SystemRoot 'System32\wscript.exe'
            $expectedArguments = (ConvertTo-ConnectorArgument (Join-Path $root 'Start Connector.vbs')) + ' /background'
            return $shortcut.TargetPath -eq $expectedTarget -and $shortcut.Arguments -eq $expectedArguments
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Set-ConnectorStartWithWindows([string]$root, [bool]$enabled, [string]$startupDirectory = '') {
    $shortcutPath = Get-ConnectorStartupPath $startupDirectory
    if (-not $enabled) {
        # Never remove a different installation's Startup shortcut accidentally.
        if (Get-ConnectorStartWithWindows $root $startupDirectory) { Remove-Item -LiteralPath $shortcutPath -Force }
        return
    }
    $launcher = Join-Path $root 'Start Connector.vbs'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'Start Connector is missing. Extract the entire Connector ZIP before enabling startup.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $shortcutPath) | Out-Null
    $shell = New-Object -ComObject WScript.Shell
    try {
        $shortcut = $shell.CreateShortcut($shortcutPath)
        try {
            $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
            $shortcut.Arguments = (ConvertTo-ConnectorArgument $launcher) + ' /background'
            $shortcut.WorkingDirectory = $root
            $shortcut.WindowStyle = 7
            $shortcut.Description = 'Run Connector in the notification area when you sign in to Windows.'
            $shortcut.Save()
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
}

function Get-ConnectorInstanceHash([string]$stateRoot) {
    $path = Join-Path $stateRoot 'desktop-instance.txt'
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    try {
        $value = (Get-Content -LiteralPath $path -Raw).Trim()
        if ($value -cmatch '^[a-f0-9]{64}$') { return $value }
    } catch { }
    return $null
}

function Test-ConnectorExistingInstance([string]$instanceHash) {
    if ($instanceHash -cnotmatch '^[a-f0-9]{64}$') { return $false }
    try {
        # Always use this fixed local address; no persisted URL or sign-in token
        # is trusted. An unrelated process on port 3000 must not be opened.
        $health = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 2
        $payload = $health.Content | ConvertFrom-Json
        return $health.Headers['X-Connector-App'] -eq 'gifted-elephant-connector' -and $payload.desktopInstance -ceq $instanceHash
    } catch { return $false }
}
