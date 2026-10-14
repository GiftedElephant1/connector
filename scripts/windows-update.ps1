# Windows PowerShell 5.1. The downloaded bundle updates an EXISTING installation.
# No credentials or raw child-process output are shown or logged.
param([switch]$InitializeOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
. (Join-Path $PSScriptRoot 'windows-background.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:sourceRoot = Split-Path -Parent $PSScriptRoot
$script:stateRoot = Join-Path $env:LOCALAPPDATA 'Connector'
$script:selectedTarget = $null
$script:busy = $false
$script:mutex = $null
$script:mutexOwned = $false
$script:showListener = $null
$script:failureMessage = 'The update could not finish. Keep both folders and try Update Connector again to recover any interrupted update.'

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Update Connector'
$form.ClientSize = New-Object System.Drawing.Size(690, 445)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Keep your accounts. Add new connectors.'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 16, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(22, 20)
$title.Size = New-Object System.Drawing.Size(646, 40)
$form.Controls.Add($title)

$instructions = New-Object System.Windows.Forms.Label
$instructions.Text = "This is the NEW download. Choose the OLD Connector folder you already use.`r`nYour connected accounts, encryption key, settings, and scheduled jobs stay in that original folder. Choose Stop Connector from its tray icon or status window before updating."
$instructions.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$instructions.Location = New-Object System.Drawing.Point(24, 72)
$instructions.Size = New-Object System.Drawing.Size(642, 76)
$form.Controls.Add($instructions)

$folderLabel = New-Object System.Windows.Forms.Label
$folderLabel.Text = 'Existing Connector folder (contains your Start Connector file):'
$folderLabel.Location = New-Object System.Drawing.Point(24, 157)
$folderLabel.Size = New-Object System.Drawing.Size(642, 24)
$form.Controls.Add($folderLabel)

$folderBox = New-Object System.Windows.Forms.TextBox
$folderBox.ReadOnly = $true
$folderBox.Location = New-Object System.Drawing.Point(24, 184)
$folderBox.Size = New-Object System.Drawing.Size(642, 26)
$form.Controls.Add($folderBox)

$browseButton = New-Object System.Windows.Forms.Button
$browseButton.Text = 'Choose existing app folder...'
$browseButton.Location = New-Object System.Drawing.Point(24, 218)
$browseButton.Size = New-Object System.Drawing.Size(220, 34)
$form.Controls.Add($browseButton)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Choose your existing folder, then click Update Connector.'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$status.Location = New-Object System.Drawing.Point(24, 266)
$status.Size = New-Object System.Drawing.Size(642, 66)
$form.Controls.Add($status)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Style = 'Marquee'
$progress.Visible = $false
$progress.Location = New-Object System.Drawing.Point(24, 342)
$progress.Size = New-Object System.Drawing.Size(642, 12)
$form.Controls.Add($progress)

$updateButton = New-Object System.Windows.Forms.Button
$updateButton.Text = 'Update Connector'
$updateButton.Enabled = $false
$updateButton.Location = New-Object System.Drawing.Point(24, 375)
$updateButton.Size = New-Object System.Drawing.Size(180, 40)
$form.Controls.Add($updateButton)

$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = 'Start Connector'
$startButton.Enabled = $false
$startButton.Location = New-Object System.Drawing.Point(220, 375)
$startButton.Size = New-Object System.Drawing.Size(180, 40)
$form.Controls.Add($startButton)

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Text = 'Close'
$closeButton.Location = New-Object System.Drawing.Point(536, 375)
$closeButton.Size = New-Object System.Drawing.Size(130, 40)
$closeButton.Add_Click({ $form.Close() })
$form.Controls.Add($closeButton)

# Never terminate the engine between swapping files and committing its journal.
# The updater remains responsive, but Close and the window X wait for completion.
$form.Add_FormClosing({ param($sender, $eventArgs) if ($script:busy) { $eventArgs.Cancel = $true } })

function Set-UpdateStatus([string]$message) {
    $status.Text = $message
    [System.Windows.Forms.Application]::DoEvents()
}

function Release-UpdateMutex {
    Stop-ConnectorShowListener $script:showListener
    $script:showListener = $null
    if ($script:mutexOwned) { $script:mutex.ReleaseMutex(); $script:mutexOwned = $false }
    if ($script:mutex) { $script:mutex.Dispose(); $script:mutex = $null }
}

function Show-ConnectorUpdateWindow {
    if ($form.IsDisposed) { return }
    $form.WindowState = 'Normal'
    $form.ShowInTaskbar = $true
    $form.Show()
    [void]$form.Activate()
}

function Assert-UpdatePortAvailable([int]$port) {
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid port.' }
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
    try { $probe.Start() } finally { $probe.Stop() }
}

function Invoke-UpdateEngine([string[]]$arguments, [switch]$checkOnly) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:runtime.NodeExe
    $engine = Join-Path $script:sourceRoot 'scripts\update.mjs'
    $allArguments = @($engine) + $arguments
    $info.Arguments = ($allArguments | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
    $info.WorkingDirectory = $script:sourceRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
    $info.EnvironmentVariables['PATH'] = $script:runtime.Directory + ';' + $env:PATH
    $info.EnvironmentVariables['npm_config_cache'] = Join-Path $script:stateRoot 'npm-cache'
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    $started = $false
    try {
        [void]$process.Start()
        $started = $true
        # Always drain both pipes; npm output remains inside the engine and is never displayed.
        $errorOutput = $process.StandardError.ReadToEndAsync()
        $nextLine = $process.StandardOutput.ReadLineAsync()
        $result = $null
        while ($null -ne $nextLine) {
            while (-not $nextLine.IsCompleted) {
                [System.Windows.Forms.Application]::DoEvents()
                Start-Sleep -Milliseconds 100
            }
            $line = $nextLine.GetAwaiter().GetResult()
            if ($null -eq $line) { break }
            try {
                $event = $line | ConvertFrom-Json
                if ($checkOnly) { $result = $event }
                elseif ($event.event -eq 'progress') {
                    # Only fixed labels enter the UI. Unexpected JSON and raw output are ignored.
                    switch ($event.code) {
                        'preparing' { Set-UpdateStatus 'Preparing a separate copy. Your existing accounts and settings stay in place.' }
                        'installing' { Set-UpdateStatus 'Installing the new components. This may take several minutes. Keep this window open.' }
                        'building' { Set-UpdateStatus 'Checking and building the new app before changing the existing installation.' }
                        'applying' { Set-UpdateStatus 'Applying the verified update. Keep this window open until it finishes.' }
                        'rolling-back' { Set-UpdateStatus 'Restoring the previous app after an unsuccessful update. Keep this window open.' }
                        'recovering' { Set-UpdateStatus 'Recovering an interrupted update before continuing. Keep this window open.' }
                    }
                }
            } catch { }
            $nextLine = $process.StandardOutput.ReadLineAsync()
        }
        while (-not $process.HasExited -or -not $errorOutput.IsCompleted) {
            [System.Windows.Forms.Application]::DoEvents()
            Start-Sleep -Milliseconds 100
        }
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) {
            try {
                $failure = $errorOutput.GetAwaiter().GetResult() | ConvertFrom-Json
                switch ($failure.code) {
                    'UNSAFE_PATH' { $script:failureMessage = 'Choose two separate, fully extracted Connector folders. Neither folder may be inside the other or reached through a folder shortcut or junction.' }
                    'INVALID_INSTALLATION' { $script:failureMessage = 'Choose your OLD Connector folder containing the saved configuration and Start Connector file.' }
                    'INVALID_BUNDLE' { $script:failureMessage = 'Download the newest Connector package and extract both ZIP layers before opening Update Connector.' }
                    'INVALID_CONFIGURATION' { $script:failureMessage = 'Your original private configuration is incomplete. Keep the existing folder and account data. Restore your original .env from a private backup or ask for help.' }
                    'UNSAFE_DATA_DIRECTORY' { $script:failureMessage = 'Your custom account storage overlaps application files. The updater has stopped to protect it. Keep your existing folder and ask for help moving that storage.' }
                    'DOWNGRADE' { $script:failureMessage = 'This download is older than your installed Connector. Download the newest successful Package Windows app build.' }
                    'PREPARATION_FAILED' { $script:failureMessage = 'The new app could not be installed or built. Check your Internet connection and free disk space, then try again. The installed app was not changed.' }
                    'UPDATE_FAILED' { $script:failureMessage = 'The update could not be applied. The previous application files have been restored. Close any apps using your Connector folder and try again.' }
                    'RECOVERY_REQUIRED' { $script:failureMessage = 'An interrupted update needs recovery. Keep both folders, close applications using your Connector folder, then run Update Connector again.' }
                }
            } catch { }
            throw 'Update engine did not complete.'
        }
        if ($checkOnly) { return $result }
    } finally {
        # Even an unexpected pipe/UI error must not release the launcher mutex
        # while the engine may still be swapping files. Wait without killing it.
        if ($started) {
            while (-not $process.HasExited) {
                [System.Windows.Forms.Application]::DoEvents()
                Start-Sleep -Milliseconds 100
            }
        }
        # Dispose only the handle. Do not kill an updater which could be committing.
        $process.Dispose()
    }
}

$browseButton.Add_Click({
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $dialog.Description = 'Select the OLD Connector folder you already use, containing Start Connector.'
    $dialog.ShowNewFolderButton = $false
    if ($script:selectedTarget) { $dialog.SelectedPath = $script:selectedTarget }
    try {
        if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
            $script:selectedTarget = $dialog.SelectedPath
            $folderBox.Text = $script:selectedTarget
            $updateButton.Enabled = $true
            $startButton.Enabled = $false
            Set-UpdateStatus 'Ready. Choose Stop Connector from its system tray icon or status window, then click Update Connector. Closing the window only hides it.'
        }
    } finally { $dialog.Dispose() }
})

$updateButton.Add_Click({
    $script:busy = $true
    $updateButton.Enabled = $false
    $browseButton.Enabled = $false
    $startButton.Enabled = $false
    $closeButton.Enabled = $false
    $progress.Visible = $true
    $succeeded = $false
    try {
        $script:failureMessage = 'Choose the OLD Connector folder containing your existing Start Connector file and private configuration. Keep the new download in a separate folder.'
        if (-not $script:selectedTarget -or
            -not (Test-Path -LiteralPath (Join-Path $script:selectedTarget '.env') -PathType Leaf) -or
            (-not (Test-Path -LiteralPath (Join-Path $script:selectedTarget 'Start Connector.vbs') -PathType Leaf) -and
             -not (Test-Path -LiteralPath (Join-Path $script:selectedTarget '.connector-update\journal.json') -PathType Leaf)) -or
            [String]::Equals([IO.Path]::GetFullPath($script:selectedTarget).TrimEnd('\'), [IO.Path]::GetFullPath($script:sourceRoot).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Existing installation not selected.'
        }

        $script:failureMessage = 'Choose Stop Connector from its system tray icon (near the Windows clock) or status window, then try again. Closing the window only hides it. The updater has not stopped any applications.'
        $script:mutex = New-Object System.Threading.Mutex($false, 'Local\GiftedElephantConnectorDesktop')
        try { $script:mutexOwned = $script:mutex.WaitOne(0) }
        catch [System.Threading.AbandonedMutexException] { $script:mutexOwned = $true }
        if (-not $script:mutexOwned) { throw 'Connector is running.' }
        $script:showListener = Start-ConnectorShowListener { Show-ConnectorUpdateWindow }
        Assert-UpdatePortAvailable 3000

        $script:failureMessage = 'The private runtime is missing. Open Start Connector in the NEW download, let setup finish, then Stop Connector. Reopen this updater and choose your OLD folder.'
        $script:runtime = Get-ConnectorRuntimeSpecification $script:stateRoot
        if (-not (Test-Path -LiteralPath $script:runtime.NodeExe -PathType Leaf) -or
            (Get-FileHash -LiteralPath $script:runtime.NodeExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $script:runtime.NodeSha) {
            throw 'Private runtime not available.'
        }
        $npmCli = Join-Path $script:runtime.Directory 'node_modules\npm\bin\npm-cli.js'
        if (-not (Test-Path -LiteralPath $npmCli -PathType Leaf)) { throw 'Private package manager not available.' }

        $script:failureMessage = 'The update could not finish. Keep both folders and try Update Connector again to recover any interrupted update. Your private configuration and account storage are excluded from updates.'
        Set-UpdateStatus 'Checking the existing installation and update package. Keep this window open until the update finishes.'
        $details = Invoke-UpdateEngine @('--target', $script:selectedTarget, '--check-only') -checkOnly
        if ($null -eq $details -or -not $details.currentVersion -or -not $details.newVersion) { throw 'Update check did not return valid details.' }
        $script:failureMessage = 'The existing Connector port is still in use. Stop Connector or the other application using its port, then try again. The updater does not stop other applications.'
        Assert-UpdatePortAvailable ([int]$details.port)
        Set-UpdateStatus ('Updating version ' + $details.currentVersion + ' to ' + $details.newVersion + '. Your accounts and settings stay in the existing folder.')
        $script:failureMessage = 'The update could not finish. Keep both folders and try Update Connector again to recover any interrupted update. Your private configuration and account storage are excluded from updates.'
        Invoke-UpdateEngine @('--target', $script:selectedTarget, '--npm-cli', $npmCli)
        $succeeded = $true
        $title.Text = 'Your Connector update is ready'
        Set-UpdateStatus 'Your accounts and settings are preserved. Click Start Connector below. Continue using Start Connector in your ORIGINAL folder next time.'
    } catch {
        $title.Text = 'The update needs attention'
        Set-UpdateStatus $script:failureMessage
    } finally {
        Release-UpdateMutex
        $script:busy = $false
        $progress.Visible = $false
        $closeButton.Enabled = $true
        $browseButton.Enabled = $true
        $updateButton.Enabled = (-not $succeeded)
        $startButton.Enabled = $succeeded
    }
})

$startButton.Add_Click({
    try {
        $info = New-Object System.Diagnostics.ProcessStartInfo
        $info.FileName = Join-Path $env:SystemRoot 'System32\wscript.exe'
        $info.Arguments = ConvertTo-ConnectorArgument (Join-Path $script:selectedTarget 'Start Connector.vbs')
        $info.WorkingDirectory = $script:selectedTarget
        $info.UseShellExecute = $false
        [void][System.Diagnostics.Process]::Start($info)
        $form.Close()
    } catch { Set-UpdateStatus 'The update is complete. Open Start Connector from your ORIGINAL Connector folder to launch it.' }
})

# Native Windows tests use the production controls without starting an update.
if ($InitializeOnly) { return }

try { [void]$form.ShowDialog() }
finally { Release-UpdateMutex; $form.Dispose() }
