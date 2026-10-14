# Exercise the production WinForms handlers with isolated state and a harmless
# Node fixture. Each scenario gets a fresh PowerShell process and UI lifetime.
param([string]$Scenario = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Scenario) {
    foreach ($case in @('background', 'failure', 'stop', 'shutdown', 'startup', 'duplicate')) {
        & powershell.exe -NoLogo -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $PSCommandPath -Scenario $case
        if ($LASTEXITCODE -ne 0) { throw ('Windows launcher scenario failed: ' + $case) }
    }
    Write-Output 'Windows background launcher event, process, startup, and instance checks passed.'
    return
}

function Assert-True([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}
function Assert-Equal($actual, $expected, [string]$message) {
    if (-not [String]::Equals([string]$actual, [string]$expected, [StringComparison]::Ordinal)) { throw $message }
}
function Wait-TestCondition([scriptblock]$condition, [string]$message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (& $condition) { return }
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 25
    }
    throw $message
}

$repository = Split-Path -Parent $PSScriptRoot
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('connector launcher ' + [Guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA
New-Item -ItemType Directory -Path $temporary | Out-Null
$env:LOCALAPPDATA = $temporary

try {
    # The initialize-only entry point creates the exact production controls and
    # event handlers, but never downloads or starts the real Connector server.
    . (Join-Path $repository 'scripts/windows-launcher.ps1') -InitializeOnly

    $script:browserLaunches = New-Object 'System.Collections.Generic.List[string]'
    function Start-Process {
        param([string]$FilePath, $ArgumentList)
        $script:browserLaunches.Add($FilePath)
    }

    function Start-TestChild([switch]$IgnoreStop) {
        foreach ($marker in @('ready', 'ping', 'stopped')) {
            $markerPath = Join-Path $temporary $marker
            if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force }
        }
        $fixturePath = Join-Path $temporary 'child.mjs'
        $fixtureSource = @'
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const [folder, ignoreStop] = process.argv.slice(2);
createInterface({ input: process.stdin }).on('line', (line) => {
  if (line === 'ping') writeFileSync(`${folder}/ping`, 'responsive');
  if (line === 'stop' && ignoreStop !== 'yes') {
    writeFileSync(`${folder}/stopped`, 'graceful');
    process.exit(0);
  }
});
writeFileSync(`${folder}/ready`, 'ready');
setInterval(() => {}, 1000);
'@
        [IO.File]::WriteAllText($fixturePath, $fixtureSource, (New-Object System.Text.UTF8Encoding($false)))
        $script:nodeExe = (Get-Command node -ErrorAction Stop).Source
        $script:nodeDirectory = Split-Path -Parent $script:nodeExe
        $script:job = New-Object ConnectorChildJob
        $ignoreArgument = 'no'
        if ($IgnoreStop) { $ignoreArgument = 'yes' }
        $arguments = (@($fixturePath, $temporary, $ignoreArgument) | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
        $run = Start-OwnedNode $arguments
        $script:child = $run.Process
        Wait-TestCondition { Test-Path -LiteralPath (Join-Path $temporary 'ready') } 'The isolated child fixture did not start.'
    }

    switch ($Scenario) {
        'background' {
            Start-TestChild
            $form.Show()
            $script:desktopToken = 'isolated-one-use-test-token'
            Set-ConnectorReady
            Assert-Equal $script:browserLaunches.Count 1 'A manual launch did not open the dashboard once.'
            Assert-Equal $script:browserLaunches[0] 'http://127.0.0.1:3000/#desktopToken=isolated-one-use-test-token' 'Manual launch lost its one-use local sign-in link.'
            Assert-Equal $script:readyUrl 'http://127.0.0.1:3000/' 'The sign-in token remained in subsequent dashboard links.'
            Assert-True ($null -eq $script:desktopToken) 'The launcher retained its initial sign-in token.'

            $hideButton.PerformClick()
            Assert-True (-not $form.Visible -and -not $form.IsDisposed) 'Hide to tray disposed or left the status window visible.'
            Assert-True $trayIcon.Visible 'The hidden launcher has no tray icon.'
            $trayStatus.PerformClick()
            Assert-True $form.Visible 'The tray Show status action did not restore the status window.'
            $form.Close()
            Assert-True (-not $form.Visible -and -not $form.IsDisposed) 'Closing the running window did not hide it.'
            Assert-True (-not $script:cancelled -and -not $script:stopRequested) 'Closing the running window stopped its event loop.'
            Assert-True (-not $script:child.HasExited) 'Closing the window terminated the background child.'
            $script:child.StandardInput.WriteLine('ping')
            $script:child.StandardInput.Flush()
            Wait-TestCondition { Test-Path -LiteralPath (Join-Path $temporary 'ping') } 'The child stopped responding after the status window was closed.'

            $trayOpen.PerformClick()
            Assert-Equal $script:browserLaunches.Count 2 'The tray Open Connector action did not open the dashboard.'
            Assert-Equal $script:browserLaunches[1] 'http://127.0.0.1:3000/' 'Reopening exposed a previously consumed sign-in token.'
            $trayStatus.PerformClick()
            $form.WindowState = 'Minimized'
            [System.Windows.Forms.Application]::DoEvents()
            Assert-True (-not $form.Visible -and -not $script:cancelled) 'Minimizing stopped Connector or kept a taskbar window open.'
        }
        'failure' {
            $script:backgroundStart = $true
            $script:desktopToken = 'unused-background-token'
            $null = $form.Handle
            Set-ConnectorReady
            Assert-Equal $script:browserLaunches.Count 0 'Windows sign-in startup opened a browser.'
            Assert-True (-not $form.Visible -and $trayIcon.Visible) 'Windows sign-in startup did not remain in the tray.'
            Assert-True ($null -eq $script:desktopToken) 'An unattended start retained a sign-in token.'
            Set-ConnectorFailure 'Connector has stopped. Open Start Connector to try again.'
            Assert-True ($form.Visible -and $form.ShowInTaskbar) 'A background failure did not display its recovery instructions.'
            Assert-True (-not $openButton.Enabled -and -not $trayOpen.Enabled -and -not $hideButton.Enabled) 'A failed launcher still advertised a usable server.'
            Assert-Equal $title.Text 'Connector needs attention' 'The failed launcher did not identify the error state.'
            $form.Close()
            Assert-True $script:cancelled 'Closing an error window hid an unusable launcher instead of exiting.'
        }
        'stop' {
            Start-TestChild
            $form.Show()
            $script:backgroundStart = $true
            Set-ConnectorReady
            $childId = $script:child.Id
            $trayStop.PerformClick()
            Assert-True ($script:cancelled -and $script:stopRequested) 'The tray Stop Connector action did not request termination.'
            Stop-ConnectorOwnedProcesses
            Assert-Equal (Get-Content -LiteralPath (Join-Path $temporary 'stopped') -Raw) 'graceful' 'Explicit Stop did not give the server its graceful stdin shutdown command.'
            Assert-True ($null -eq $script:job -and $null -eq $script:child) 'Stopping retained the owned process or job handle.'
            Assert-True ($null -eq (Get-Process -Id $childId -ErrorAction SilentlyContinue)) 'The gracefully stopped server is still running.'

            Start-TestChild -IgnoreStop
            $stubbornId = $script:child.Id
            Stop-ConnectorOwnedProcesses
            Wait-TestCondition { $null -eq (Get-Process -Id $stubbornId -ErrorAction SilentlyContinue) } 'The owned job did not terminate a child that ignored graceful Stop.'
            Assert-True (-not (Test-Path -LiteralPath (Join-Path $temporary 'stopped'))) 'The ignored-stop fixture did not exercise the job cleanup fallback.'
        }
        'shutdown' {
            $script:backgroundStart = $true
            $null = $form.Handle
            Set-ConnectorReady
            $onClosing = [System.Windows.Forms.Form].GetMethod('OnFormClosing', [Reflection.BindingFlags]'Instance,NonPublic')
            foreach ($reason in @('WindowsShutDown', 'TaskManagerClosing', 'ApplicationExitCall')) {
                $script:cancelled = $false
                $eventArgs = New-Object System.Windows.Forms.FormClosingEventArgs([System.Windows.Forms.CloseReason]::$reason, $false)
                [void]$onClosing.Invoke($form, @($eventArgs))
                Assert-True (-not $eventArgs.Cancel -and $script:cancelled) ('The close-to-tray handler intercepted Windows termination: ' + $reason)
            }
            $script:phase = 'Starting'
            $script:cancelled = $false
            $eventArgs = New-Object System.Windows.Forms.FormClosingEventArgs([System.Windows.Forms.CloseReason]::UserClosing, $false)
            [void]$onClosing.Invoke($form, @($eventArgs))
            Assert-True (-not $eventArgs.Cancel -and $script:cancelled) 'Closing during setup hid an unfinished launcher instead of cancelling it.'
        }
        'startup' {
            $startupDirectory = Join-Path $temporary 'isolated Startup'
            $installation = Join-Path $temporary ("Original O'Brien " + [char]0x540c + [char]0x6b65)
            New-Item -ItemType Directory -Path $installation | Out-Null
            Set-Content -LiteralPath (Join-Path $installation 'Start Connector.vbs') -Value "' isolated test launcher"
            Assert-True (-not (Get-ConnectorStartWithWindows $installation $startupDirectory)) 'Startup was enabled before the user selected it.'
            Set-ConnectorStartWithWindows $installation $true $startupDirectory
            Assert-True (Get-ConnectorStartWithWindows $installation $startupDirectory) 'Startup registration did not round-trip through Windows shortcut storage.'
            $shortcutPath = Get-ConnectorStartupPath $startupDirectory
            $shell = New-Object -ComObject WScript.Shell
            try {
                $shortcut = $shell.CreateShortcut($shortcutPath)
                try {
                    Assert-True ($shortcut.TargetPath -ieq (Join-Path $env:SystemRoot 'System32\wscript.exe')) 'Startup invokes an unexpected executable.'
                    Assert-Equal $shortcut.Arguments ('"' + (Join-Path $installation 'Start Connector.vbs') + '" /background') 'Startup lost quoting or the no-browser background argument.'
                    Assert-Equal $shortcut.WorkingDirectory $installation 'Startup changed the selected installation folder.'
                } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
            } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
            Set-ConnectorStartWithWindows $installation $true $startupDirectory
            Assert-Equal @(Get-ChildItem -LiteralPath $startupDirectory -Filter '*.lnk').Count 1 'Repeated startup selection created duplicate entries.'
            Set-ConnectorStartWithWindows (Join-Path $temporary 'different installation') $false $startupDirectory
            Assert-True (Test-Path -LiteralPath $shortcutPath) 'Disabling startup for another installation deleted this installation startup entry.'
            Set-ConnectorStartWithWindows $installation $false $startupDirectory
            Assert-True (-not (Test-Path -LiteralPath $shortcutPath)) 'Turning off startup left its shortcut installed.'

            # Reuse the real shortcut helpers through a temporary-directory
            # adapter so the actual checkbox/menu handlers never touch Startup.
            $script:testStartupDirectory = $startupDirectory
            $script:actualSetStartup = (Get-Command Set-ConnectorStartWithWindows).ScriptBlock
            $script:actualGetStartup = (Get-Command Get-ConnectorStartWithWindows).ScriptBlock
            function Set-ConnectorStartWithWindows([string]$root, [bool]$enabled) { & $script:actualSetStartup $root $enabled $script:testStartupDirectory }
            function Get-ConnectorStartWithWindows([string]$root) { & $script:actualGetStartup $root $script:testStartupDirectory }
            $script:root = $installation
            $startupCheckbox.Enabled = $true
            $trayStartup.Enabled = $true
            $startupCheckbox.Checked = $true
            Assert-True ($trayStartup.Checked -and (Test-Path -LiteralPath $shortcutPath)) 'The Start with Windows checkbox did not update startup and the tray control.'
            $trayStartup.PerformClick()
            Assert-True (-not $startupCheckbox.Checked -and -not (Test-Path -LiteralPath $shortcutPath)) 'The tray startup toggle did not disable startup and synchronize its checkbox.'
        }
        'duplicate' {
            $hash = 'a' * 64
            $marker = Join-Path $script:stateRoot 'desktop-instance.txt'
            Assert-True ($null -eq (Get-ConnectorInstanceHash $script:stateRoot)) 'A missing instance marker was accepted.'
            Set-Content -LiteralPath $marker -Value 'http://unrelated.invalid/#private-token'
            Assert-True ($null -eq (Get-ConnectorInstanceHash $script:stateRoot)) 'An untrusted URL or token was accepted as an instance marker.'
            Set-Content -LiteralPath $marker -Value $hash
            Assert-Equal (Get-ConnectorInstanceHash $script:stateRoot) $hash 'The saved instance fingerprint did not round-trip.'
            $script:healthCalls = 0
            $script:testHealth = @{ Headers = @{ 'X-Connector-App' = 'gifted-elephant-connector' }; Content = (@{ desktopInstance = $hash } | ConvertTo-Json -Compress) }
            function Invoke-WebRequest {
                param([string]$Uri, [switch]$UseBasicParsing, [int]$TimeoutSec)
                $script:healthCalls++
                Assert-Equal $Uri 'http://127.0.0.1:3000/api/health' 'Duplicate start requested an untrusted address.'
                return $script:testHealth
            }
            Assert-True (Test-ConnectorExistingInstance $hash) 'A matching running instance could not be reopened.'
            $script:testHealth.Headers['X-Connector-App'] = 'other-app'
            Assert-True (-not (Test-ConnectorExistingInstance $hash)) 'Duplicate start accepted an unrelated application on port 3000.'
            $script:testHealth.Headers['X-Connector-App'] = 'gifted-elephant-connector'
            $script:testHealth.Content = (@{ desktopInstance = ('b' * 64) } | ConvertTo-Json -Compress)
            Assert-True (-not (Test-ConnectorExistingInstance $hash)) 'Duplicate start accepted a different Connector instance.'
            $script:testHealth.Content = 'not json'
            Assert-True (-not (Test-ConnectorExistingInstance $hash)) 'An invalid health response was accepted.'
            $callsBeforeInvalid = $script:healthCalls
            Assert-True (-not (Test-ConnectorExistingInstance 'bad-marker')) 'An invalid fingerprint was accepted.'
            Assert-Equal $script:healthCalls $callsBeforeInvalid 'An invalid marker triggered a network request.'

            # Hold the real launcher mutex while another process runs the actual
            # startup branch. It must exit before downloads or server startup.
            $mutex = New-Object System.Threading.Mutex($false, 'Local\GiftedElephantConnectorDesktop')
            $owned = $false
            try {
                $owned = $mutex.WaitOne(0)
                Assert-True $owned 'Close any running Connector before executing the isolated launcher tests.'
                $wrapper = Join-Path $temporary 'duplicate-wrapper.ps1'
                $browserMarker = Join-Path $temporary 'duplicate-browser.txt'
                $wrapperSource = @'
param([string]$Launcher, [string]$BrowserMarker, [string]$BackgroundMode)
$ErrorActionPreference = 'Stop'
function Start-Process([string]$FilePath) { Set-Content -LiteralPath $BrowserMarker -Value $FilePath }
function Invoke-WebRequest {
    return @{ Headers = @{ 'X-Connector-App' = 'gifted-elephant-connector' }; Content = ('{"desktopInstance":"' + ('a' * 64) + '"}') }
}
. $Launcher -Background:($BackgroundMode -eq 'yes')
'@
                [IO.File]::WriteAllText($wrapper, $wrapperSource, (New-Object System.Text.UTF8Encoding($false)))
                foreach ($mode in @('yes', 'no')) {
                    $info = New-Object System.Diagnostics.ProcessStartInfo
                    $info.FileName = Join-Path $PSHOME 'powershell.exe'
                    $nativeArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $wrapper, '-Launcher', (Join-Path $repository 'scripts/windows-launcher.ps1'), '-BrowserMarker', $browserMarker, '-BackgroundMode', $mode)
                    $info.Arguments = ($nativeArguments | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
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
                        Assert-True ($process.WaitForExit(20000)) 'Duplicate start did not exit promptly before runtime setup.'
                        Assert-Equal $process.ExitCode 0 ('Duplicate startup failed: ' + $errors.GetAwaiter().GetResult())
                    } finally {
                        if (-not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
                        $process.Dispose()
                    }
                    if ($mode -eq 'yes') { Assert-True (-not (Test-Path -LiteralPath $browserMarker)) 'Duplicate Windows sign-in startup opened a browser.' }
                    else { Assert-Equal (Get-Content -LiteralPath $browserMarker -Raw).Trim() 'http://127.0.0.1:3000/' 'Manual duplicate start did not reopen the verified dashboard.' }
                    Assert-Equal (Get-ConnectorInstanceHash $script:stateRoot) $hash 'Duplicate startup removed the existing launcher instance marker.'
                }
            } finally {
                if ($owned) { $mutex.ReleaseMutex() }
                $mutex.Dispose()
            }
        }
        default { throw ('Unknown launcher test scenario: ' + $Scenario) }
    }
} finally {
    # Cleanup is defensive so a failing assertion cannot leave a fixture running.
    if (Get-Command Stop-ConnectorOwnedProcesses -ErrorAction SilentlyContinue) { Stop-ConnectorOwnedProcesses }
    if (Get-Variable trayIcon -ErrorAction SilentlyContinue) { $trayIcon.Visible = $false; $trayIcon.Dispose() }
    if (Get-Variable trayMenu -ErrorAction SilentlyContinue) { $trayMenu.Dispose() }
    if (Get-Variable form -ErrorAction SilentlyContinue) { $form.Dispose() }
    $env:LOCALAPPDATA = $originalLocalAppData
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
Write-Output ('Windows launcher scenario passed: ' + $Scenario)
