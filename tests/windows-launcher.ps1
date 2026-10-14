# Exercise the production WinForms handlers with isolated state and a harmless
# Node fixture. Each scenario gets a fresh PowerShell process and UI lifetime.
param([string]$Scenario = '')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $Scenario) {
    . (Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts/windows-common.ps1')
    $failedScenarios = New-Object 'System.Collections.Generic.List[string]'
    foreach ($case in @('background', 'failure', 'stop', 'shutdown', 'startup', 'duplicate', 'reopen-starting', 'reopen-failed', 'reopen-running', 'reopen-update', 'reopen-legacy', 'reopen-legacy-update', 'reopen-unidentified')) {
        $scenarioInfo = New-Object System.Diagnostics.ProcessStartInfo
        $scenarioInfo.FileName = Join-Path $PSHOME 'powershell.exe'
        $scenarioArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Scenario', $case)
        $scenarioInfo.Arguments = ($scenarioArguments | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
        $scenarioInfo.UseShellExecute = $false
        $scenarioInfo.CreateNoWindow = $true
        $scenarioInfo.RedirectStandardOutput = $true
        $scenarioInfo.RedirectStandardError = $true
        $scenarioProcess = New-Object System.Diagnostics.Process
        $scenarioProcess.StartInfo = $scenarioInfo
        $scenarioStarted = $false
        try {
            [void]$scenarioProcess.Start()
            $scenarioStarted = $true
            $scenarioOutput = $scenarioProcess.StandardOutput.ReadToEndAsync()
            $scenarioErrors = $scenarioProcess.StandardError.ReadToEndAsync()
            if (-not $scenarioProcess.WaitForExit(60000)) {
                $scenarioProcess.Kill()
                $scenarioProcess.WaitForExit()
                Write-Output ('::error title=Windows launcher ' + $case + '::The isolated scenario timed out after 60 seconds.')
                $failedScenarios.Add($case)
            } elseif ($scenarioProcess.ExitCode -ne 0) { $failedScenarios.Add($case) }
            $capturedOutput = $scenarioOutput.GetAwaiter().GetResult()
            $capturedErrors = $scenarioErrors.GetAwaiter().GetResult()
            if ($capturedOutput) { Write-Output $capturedOutput.TrimEnd() }
            if ($capturedErrors) { Write-Output $capturedErrors.TrimEnd() }
        } catch {
            $failedScenarios.Add($case)
            $message = ($_.Exception.Message + ' ' + $_.ScriptStackTrace).Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
            Write-Output ('::error title=Windows launcher ' + $case + '::' + $message)
        } finally {
            if ($scenarioStarted -and -not $scenarioProcess.HasExited) { $scenarioProcess.Kill(); $scenarioProcess.WaitForExit() }
            $scenarioProcess.Dispose()
        }
    }
    if ($failedScenarios.Count) { throw ('Windows launcher scenarios failed: ' + ($failedScenarios -join ', ')) }
    Write-Output 'Windows background launcher event, process, startup, and instance checks passed.'
    return
}

trap {
    # GitHub exposes annotations even when raw Windows logs require sign-in.
    # Include the failing assertion and its source line, not only an exit code.
    $message = ($_.Exception.Message + ' ' + $_.ScriptStackTrace).Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
    Write-Output ('::error title=Windows launcher ' + $Scenario + '::' + $message)
    exit 1
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

function Start-TestPowerShell([string]$path, [string[]]$arguments) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = Join-Path $PSHOME 'powershell.exe'
    $nativeArguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', $path) + $arguments
    $info.Arguments = ($nativeArguments | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        return @{ Process = $process; Output = $process.StandardOutput.ReadToEndAsync(); Errors = $process.StandardError.ReadToEndAsync() }
    } catch { $process.Dispose(); throw }
}

function Stop-TestPowerShell($run, [string]$controlDirectory = '') {
    if (-not $run) { return }
    if ($controlDirectory -and -not $run.Process.HasExited) {
        [IO.File]::WriteAllText((Join-Path $controlDirectory 'owner-stop.txt'), 'stop')
        [void]$run.Process.WaitForExit(5000)
    }
    if (-not $run.Process.HasExited) { $run.Process.Kill(); $run.Process.WaitForExit() }
    $run.Process.Dispose()
}

function Assert-TestPowerShellExit($run, [string]$message) {
    Assert-True ($run.Process.WaitForExit(20000)) ($message + ' The process did not exit within 20 seconds.')
    $output = $run.Output.GetAwaiter().GetResult()
    $errors = $run.Errors.GetAwaiter().GetResult()
    Assert-Equal $run.Process.ExitCode 0 ($message + ' ' + $output + ' ' + $errors)
}

function Assert-TestOwnerAlive($run) {
    if ($run.Process.HasExited) {
        throw ('The isolated owner exited unexpectedly (exit ' + $run.Process.ExitCode + '). ' + $run.Output.GetAwaiter().GetResult() + ' ' + $run.Errors.GetAwaiter().GetResult())
    }
}

function Get-TestOwnerSnapshot([string]$directory, $owner) {
    Assert-TestOwnerAlive $owner
    $request = [Guid]::NewGuid().ToString('N')
    # Every request/response is immutable. Windows PowerShell's Set-Content and
    # Get-Content can hold incompatible file-sharing modes, so repeatedly
    # replacing one mailbox file races the other process even in tiny fixtures.
    [IO.File]::WriteAllText((Join-Path $directory ('request-' + $request + '.ready')), '')
    $responsePath = Join-Path $directory ('snapshot-' + $request + '.json')
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while ([DateTime]::UtcNow -lt $deadline) {
        Assert-TestOwnerAlive $owner
        # The owner closes the writer before atomically publishing this path.
        if ([IO.File]::Exists($responsePath)) { return ([IO.File]::ReadAllText($responsePath) | ConvertFrom-Json) }
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 25
    }
    Assert-TestOwnerAlive $owner
    throw ('The existing launcher did not respond to the isolated state inspection; owner process ' + $owner.Process.Id + ' is still running.')
}

$repository = Split-Path -Parent $PSScriptRoot
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('connector launcher ' + [Guid]::NewGuid().ToString('N'))
$originalLocalAppData = $env:LOCALAPPDATA
New-Item -ItemType Directory -Path $temporary | Out-Null
$env:LOCALAPPDATA = $temporary
$script:scenarioFailure = $null

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
            # Reflection does not unwrap PowerShell 5.1 PSObject values inside
            # object[] arguments. Use a typed adapter to raise the real event.
            Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System.Reflection;
using System.Windows.Forms;
public static class ConnectorLauncherTestEvents {
    public static FormClosingEventArgs RaiseClosing(Form form, CloseReason reason) {
        var args = new FormClosingEventArgs(reason, false);
        typeof(Form).GetMethod("OnFormClosing", BindingFlags.Instance | BindingFlags.NonPublic)
            .Invoke(form, new object[] { args });
        return args;
    }
}
'@
            foreach ($reason in @('WindowsShutDown', 'TaskManagerClosing', 'ApplicationExitCall')) {
                $script:cancelled = $false
                $eventArgs = [ConnectorLauncherTestEvents]::RaiseClosing($form, [System.Windows.Forms.CloseReason]::$reason)
                Assert-True (-not $eventArgs.Cancel -and $script:cancelled) ('The close-to-tray handler intercepted Windows termination: ' + $reason)
            }
            $script:phase = 'Starting'
            $script:cancelled = $false
            $eventArgs = [ConnectorLauncherTestEvents]::RaiseClosing($form, [System.Windows.Forms.CloseReason]::UserClosing)
            Assert-True (-not $eventArgs.Cancel -and $script:cancelled) 'Closing during setup hid an unfinished launcher instead of cancelling it.'
        }
        'startup' {
            $startupDirectory = Join-Path $temporary 'isolated Startup'
            $installation = Join-Path $temporary ("Original O'Brien " + [char]0x540c + [char]0x6b65)
            New-Item -ItemType Directory -Path $installation | Out-Null
            $startedMarker = Join-Path $temporary 'startup-script-ran.txt'
            $vbsFixture = @'
Option Explicit
Dim fileSystem, output
Set fileSystem = CreateObject("Scripting.FileSystemObject")
Set output = fileSystem.CreateTextFile("MARKER_PATH", True)
If WScript.Arguments.Count = 1 Then
  output.Write WScript.Arguments(0)
Else
  output.Write "unexpected argument count"
End If
output.Close
'@
            [IO.File]::WriteAllText((Join-Path $installation 'Start Connector.vbs'), $vbsFixture.Replace('MARKER_PATH', $startedMarker.Replace('"', '""')), (New-Object System.Text.UTF8Encoding($false)))
            Assert-True (-not (Get-ConnectorStartWithWindows $installation $startupDirectory)) 'Startup was enabled before the user selected it.'
            Set-ConnectorStartWithWindows $installation $true $startupDirectory
            $shortcutPath = Get-ConnectorStartupPath $startupDirectory
            $shortcut = Get-ConnectorStartupShortcutMetadata $shortcutPath
            $expectedTarget = Join-Path $env:SystemRoot 'System32\wscript.exe'
            $expectedArguments = '"' + (Join-Path $installation 'Start Connector.vbs') + '" /background'
            $roundTrip = Get-ConnectorStartWithWindows $installation $startupDirectory
            $diagnostic = @{
                shortcutPath = $shortcutPath; shortcutExists = (Test-Path -LiteralPath $shortcutPath);
                result = $roundTrip; resultType = $roundTrip.GetType().FullName;
                expectedTarget = $expectedTarget; actualTarget = $shortcut.TargetPath;
                targetType = $shortcut.TargetPath.GetType().FullName;
                expectedArguments = $expectedArguments; actualArguments = $shortcut.Arguments;
                argumentType = $shortcut.Arguments.GetType().FullName;
                expectedArgumentBytes = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($expectedArguments));
                actualArgumentBytes = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($shortcut.Arguments));
                expectedWorkingDirectory = $installation; actualWorkingDirectory = $shortcut.WorkingDirectory;
            } | ConvertTo-Json -Compress
            Assert-True $roundTrip ('Startup registration did not round-trip through Windows shortcut storage. ' + $diagnostic)
            Assert-True ($shortcut.TargetPath -ieq $expectedTarget) 'Startup invokes an unexpected executable.'
            Assert-Equal $shortcut.Arguments $expectedArguments 'Startup lost quoting or the no-browser background argument.'
            Assert-Equal $shortcut.WorkingDirectory $installation 'Startup changed the selected installation folder.'

            # Reading metadata is insufficient: ask Windows to launch the .lnk
            # and prove the script in the Unicode folder receives /background.
            # The fixture only writes its argument to a temporary marker file.
            $shortcutProcess = New-Object System.Diagnostics.Process
            $shortcutProcess.StartInfo.FileName = $shortcutPath
            $shortcutProcess.StartInfo.UseShellExecute = $true
            $shortcutProcess.StartInfo.ErrorDialog = $false
            $shortcutProcess.StartInfo.WindowStyle = 'Hidden'
            $shortcutJob = New-Object ConnectorChildJob
            $shortcutStarted = $false
            try {
                $shortcutStarted = $shortcutProcess.Start()
                Assert-True $shortcutStarted 'Windows did not start the isolated startup shortcut process.'
                try { $shortcutJob.Add($shortcutProcess.Handle) }
                catch { if (-not $shortcutProcess.HasExited) { throw } }
                Wait-TestCondition { Test-Path -LiteralPath $startedMarker } 'Windows could not launch the startup shortcut from the Unicode installation folder.'
                Assert-True ($shortcutProcess.WaitForExit(5000)) 'The isolated startup script did not exit.'
                Assert-Equal $shortcutProcess.ExitCode 0 'Windows reported an error running the startup shortcut.'
                Assert-Equal (Get-Content -LiteralPath $startedMarker -Raw) '/background' 'The startup shortcut did not pass the background launch argument to the real script.'
            } finally {
                $shortcutJob.Dispose()
                if ($shortcutStarted -and -not $shortcutProcess.HasExited -and -not $shortcutProcess.WaitForExit(5000)) {
                    # Also clean up if job assignment itself failed. This handle
                    # belongs only to the harmless process this test launched.
                    $shortcutProcess.Kill()
                    $shortcutProcess.WaitForExit(5000) | Out-Null
                }
                $shortcutProcess.Dispose()
            }
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
            $nativeExecutable = Join-Path $PSHOME 'powershell.exe'
            $nativeLauncher = Join-Path $temporary 'scripts/windows-launcher.ps1'
            $ownerProcess = [pscustomobject]@{
                ExecutablePath = $nativeExecutable
                CommandLine = (@($nativeExecutable, '-NoProfile', '-File', $nativeLauncher) | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
            }
            Assert-True (Test-ConnectorWindowOwner $ownerProcess 'Connector') 'The native fallback rejected the exact launcher file argument.'
            Assert-True (-not (Test-ConnectorWindowOwner $ownerProcess 'Update Connector')) 'The native fallback accepted a launcher as an updater window.'
            foreach ($unsafeArguments in @(
                @('-Command', ('Write-Output "-File ' + $nativeLauncher + '"')),
                @('-c', 'Write-Output', '-File', $nativeLauncher),
                @('-EncodedCommand', [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($nativeLauncher))),
                @('-File', (Join-Path $temporary 'scripts/unrelated.ps1'), '-File', $nativeLauncher),
                @('-File', (Join-Path $temporary 'other/windows-launcher.ps1'))
            )) {
                $ownerProcess.CommandLine = (@($nativeExecutable) + $unsafeArguments | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
                Assert-True (-not (Test-ConnectorWindowOwner $ownerProcess 'Connector')) 'The native fallback accepted an unrelated command mentioning the launcher.'
            }
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
        { $_ -like 'reopen-*' } {
            # A real second PowerShell process owns the real WinForms controls,
            # mutex, message loop and harmless child. The duplicate runs the
            # production entry point, not a reimplementation of its decisions.
            $state = switch ($Scenario) {
                'reopen-failed' { 'Failed' }
                'reopen-running' { 'Running' }
                'reopen-update' { 'Updating' }
                'reopen-legacy-update' { 'Updating' }
                default { 'Starting' }
            }
            $legacy = $Scenario -eq 'reopen-legacy' -or $Scenario -eq 'reopen-legacy-update' -or $Scenario -eq 'reopen-unidentified'
            $blocked = $Scenario -eq 'reopen-unidentified'
            $fixtureDirectory = Join-Path $temporary 'owner fixture'
            $fixtureScripts = Join-Path $fixtureDirectory 'scripts'
            New-Item -ItemType Directory -Path $fixtureScripts | Out-Null
            # Nonlegacy owners cannot pass the native fallback's -File filter;
            # these cases therefore prove the production event/timer works.
            $ownerName = 'event-owner.ps1'
            if ($legacy) { $ownerName = 'windows-launcher.ps1' }
            if ($legacy -and $state -eq 'Updating') { $ownerName = 'windows-update.ps1' }
            if ($blocked) { $ownerName = 'unrelated-window.ps1' }
            $ownerPath = Join-Path $fixtureScripts $ownerName
            $ownerSource = @'
param([string]$Launcher, [string]$Updater, [string]$State, [string]$ControlDirectory, [string]$NodeExecutable, [string]$Legacy)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. $Launcher -InitializeOnly
if ($State -eq 'Updating') {
    $trayIcon.Dispose()
    $trayMenu.Dispose()
    $form.Dispose()
    . $Updater -InitializeOnly
}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class ConnectorFixtureWindowInspection {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    public static string Text(IntPtr window) {
        var text = new StringBuilder(1024);
        GetWindowText(window, text, text.Capacity);
        return text.ToString();
    }
}
"@
$listener = $null
function Start-Process { throw 'An isolated owner unexpectedly opened an external application.' }
try {
    $script:mutex = New-Object System.Threading.Mutex($false, 'Local\GiftedElephantConnectorDesktop')
    $script:mutexOwned = $script:mutex.WaitOne(0)
    if (-not $script:mutexOwned) { throw 'Another application owns the test launcher mutex.' }
    Set-Content -LiteralPath (Join-Path $script:stateRoot 'desktop-instance.txt') -Value ('a' * 64)
    $script:root = $ControlDirectory
    $script:nodeExe = $NodeExecutable
    $script:nodeDirectory = Split-Path -Parent $NodeExecutable
    $script:job = New-Object ConnectorChildJob
    $arguments = (@((Join-Path $ControlDirectory 'owner-child.mjs'), $ControlDirectory) | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
    $run = Start-OwnedNode $arguments
    $script:child = $run.Process
    $childReady = Join-Path $ControlDirectory 'child-ready.txt'
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (-not (Test-Path -LiteralPath $childReady)) {
        if ($script:child.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'The owner child fixture did not start.' }
        [System.Windows.Forms.Application]::DoEvents()
        Start-Sleep -Milliseconds 25
    }
    $script:backgroundStart = $true
    $null = $form.Handle
    if ($State -eq 'Running') { Set-ConnectorReady }
    elseif ($State -eq 'Failed') { Set-ConnectorFailure 'Isolated original failure details remain available.' }
    elseif ($State -eq 'Updating') { $script:phase = 'Updating'; $script:busy = $true; $status.Text = 'Updating isolated fixture; do not stop this owner.' }
    $form.WindowState = 'Minimized'
    $form.Hide()
    $form.ShowInTaskbar = $false
    $script:activationCount = 0
    $script:activationState = $null
    if ($Legacy -ne 'yes') {
        if ($State -eq 'Updating') {
            $listener = Start-ConnectorShowListener {
                $script:activationCount++
                Show-ConnectorUpdateWindow
                $script:activationState = @{ visible = $form.Visible; windowState = [string]$form.WindowState; cancelled = $script:cancelled }
            }
        } else {
            $listener = Start-ConnectorShowListener {
                $script:activationCount++
                Show-ConnectorWindow
                $script:activationState = @{ visible = $form.Visible; windowState = [string]$form.WindowState; cancelled = $script:cancelled }
            }
        }
    }
    [IO.File]::WriteAllText((Join-Path $ControlDirectory 'owner-ready.txt'), [string]$PID)
    $handledRequests = New-Object 'System.Collections.Generic.HashSet[string]'
    while (-not (Test-Path -LiteralPath (Join-Path $ControlDirectory 'owner-stop.txt'))) {
        [System.Windows.Forms.Application]::DoEvents()
        foreach ($requestPath in [IO.Directory]::GetFiles($ControlDirectory, 'request-*.ready')) {
            $request = [IO.Path]::GetFileNameWithoutExtension($requestPath).Substring(8)
            if ($handledRequests.Add($request)) {
                $pingPath = Join-Path $ControlDirectory ('child-ping-' + $request + '.txt')
                $responsive = $false
                if (-not $script:child.HasExited) {
                    $script:child.StandardInput.WriteLine('ping ' + $request)
                    $script:child.StandardInput.Flush()
                    $pingDeadline = [DateTime]::UtcNow.AddSeconds(5)
                    while (-not (Test-Path -LiteralPath $pingPath) -and [DateTime]::UtcNow -lt $pingDeadline) {
                        [System.Windows.Forms.Application]::DoEvents()
                        Start-Sleep -Milliseconds 25
                    }
                    $responsive = Test-Path -LiteralPath $pingPath
                }
                $snapshot = @{
                    request = $request; phase = $script:phase; visible = $form.Visible;
                    windowState = [string]$form.WindowState; title = $title.Text; status = $status.Text;
                    cancelled = $script:cancelled; stopped = $script:stopRequested;
                    responsive = $responsive; childId = $script:child.Id; ownerId = $PID;
                    marker = Get-ConnectorInstanceHash $script:stateRoot;
                    activationCount = $script:activationCount; activationState = $script:activationState;
                    handleCreated = $form.IsHandleCreated; disposed = $form.IsDisposed; showInTaskbar = $form.ShowInTaskbar;
                    nativeVisible = [ConnectorFixtureWindowInspection]::IsWindowVisible($form.Handle);
                    nativeMinimized = [ConnectorFixtureWindowInspection]::IsIconic($form.Handle);
                    titleHandleCreated = $title.IsHandleCreated; titleNativeVisible = $false; titleNativeText = '';
                    statusHandleCreated = $status.IsHandleCreated; statusNativeVisible = $false; statusNativeText = '';
                    actionHandleCreated = $false; actionNativeVisible = $false; actionNativeText = ''; actionText = '';
                }
                # Looking at Handle itself creates it. Never do that for an
                # uncreated child: inspection must not make a blank legacy
                # frame appear usable by constructing its missing controls.
                if ($title.IsHandleCreated) {
                    $snapshot.titleNativeVisible = [ConnectorFixtureWindowInspection]::IsWindowVisible($title.Handle)
                    $snapshot.titleNativeText = [ConnectorFixtureWindowInspection]::Text($title.Handle)
                }
                if ($status.IsHandleCreated) {
                    $snapshot.statusNativeVisible = [ConnectorFixtureWindowInspection]::IsWindowVisible($status.Handle)
                    $snapshot.statusNativeText = [ConnectorFixtureWindowInspection]::Text($status.Handle)
                }
                $actionButton = $stopButton
                if ($State -eq 'Updating') { $actionButton = $closeButton }
                $snapshot.actionText = $actionButton.Text
                $snapshot.actionHandleCreated = $actionButton.IsHandleCreated
                if ($actionButton.IsHandleCreated) {
                    $snapshot.actionNativeVisible = [ConnectorFixtureWindowInspection]::IsWindowVisible($actionButton.Handle)
                    $snapshot.actionNativeText = [ConnectorFixtureWindowInspection]::Text($actionButton.Handle)
                }
                $snapshot = $snapshot | ConvertTo-Json -Compress
                $responsePath = Join-Path $ControlDirectory ('snapshot-' + $request + '.json')
                [IO.File]::WriteAllText(($responsePath + '.tmp'), $snapshot)
                [IO.File]::Move(($responsePath + '.tmp'), $responsePath)
            }
        }
        Start-Sleep -Milliseconds 25
    }
} finally {
    if ($listener) { Stop-ConnectorShowListener $listener }
    Stop-ConnectorOwnedProcesses
    if ($script:mutexOwned) { $script:mutex.ReleaseMutex() }
    if ($script:mutex) { $script:mutex.Dispose() }
    $form.Dispose()
    if ($State -ne 'Updating') { $trayIcon.Dispose(); $trayMenu.Dispose() }
}
'@
            [IO.File]::WriteAllText($ownerPath, $ownerSource, (New-Object System.Text.UTF8Encoding($false)))
            $childSource = @'
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
const folder = process.argv[2];
createInterface({ input: process.stdin }).on('line', (line) => {
  if (/^ping [a-f0-9]{32}$/.test(line)) writeFileSync(folder + '/child-ping-' + line.slice(5) + '.txt', 'responsive');
  if (line === 'stop') process.exit(0);
});
writeFileSync(folder + '/child-ready.txt', 'ready');
setInterval(() => {}, 1000);
'@
            [IO.File]::WriteAllText((Join-Path $fixtureDirectory 'owner-child.mjs'), $childSource, (New-Object System.Text.UTF8Encoding($false)))
            $duplicatePath = Join-Path $temporary 'reopen-duplicate.ps1'
            $duplicateSource = @'
param([string]$Launcher, [string]$ControlDirectory, [string]$BackgroundMode, [string]$ExpectBlocked)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Start-Process { throw 'A duplicate with no verified server unexpectedly opened a browser.' }
function Invoke-WebRequest { throw 'No test server is listening on port 3000.' }
$testTimer = $null
$script:blockedError = ''
$script:blockedVerified = $false
if ($ExpectBlocked -eq 'yes' -and $BackgroundMode -ne 'yes') {
    Add-Type -AssemblyName System.Windows.Forms
    $testTimer = New-Object System.Windows.Forms.Timer
    $testTimer.Interval = 100
    $script:blockedDeadline = [DateTime]::UtcNow.AddSeconds(10)
    $testTimer.Add_Tick({
        try {
            if ($script:phase -eq 'Existing') {
                $testTimer.Stop()
                if (-not $form.Visible -or -not $openButton.Enabled -or $openButton.Text -ne 'Retry opening Connector') { throw 'The blocked launcher did not expose an actionable Retry window.' }
                $openButton.PerformClick()
                if ($script:phase -ne 'Existing' -or $script:mutexOwned) { throw 'Retry bypassed the mutex held by an unidentified owner.' }
                if ((Get-ConnectorInstanceHash $script:stateRoot) -cne ('a' * 64)) { throw 'Retry changed the existing owner marker.' }
                $script:blockedVerified = $true
                $stopButton.PerformClick()
            } elseif ([DateTime]::UtcNow -ge $script:blockedDeadline) { throw 'The duplicate did not provide its nonmodal Retry window.' }
        } catch {
            $script:blockedError = $_.Exception.Message
            $testTimer.Stop()
            Request-ConnectorStop
        }
    })
    $testTimer.Start()
}
try { . $Launcher -Background:($BackgroundMode -eq 'yes') }
finally { if ($testTimer) { $testTimer.Stop(); $testTimer.Dispose() } }
if ($script:blockedError) { throw $script:blockedError }
if ($ExpectBlocked -eq 'yes' -and $BackgroundMode -ne 'yes') {
    if (-not $script:blockedVerified) { throw 'The unknown owner was treated as a verified Connector window.' }
    Set-Content -LiteralPath (Join-Path $ControlDirectory 'blocked-verified.txt') -Value 'verified'
}
'@
            [IO.File]::WriteAllText($duplicatePath, $duplicateSource, (New-Object System.Text.UTF8Encoding($false)))
            $legacyArgument = 'no'
            if ($legacy) { $legacyArgument = 'yes' }
            $blockedArgument = 'no'
            if ($blocked) { $blockedArgument = 'yes' }
            $owner = $null
            try {
                $ownerArguments = @('-Launcher', (Join-Path $repository 'scripts/windows-launcher.ps1'), '-Updater', (Join-Path $repository 'scripts/windows-update.ps1'), '-State', $state, '-ControlDirectory', $fixtureDirectory, '-NodeExecutable', (Get-Command node -ErrorAction Stop).Source, '-Legacy', $legacyArgument)
                $owner = Start-TestPowerShell $ownerPath $ownerArguments
                Wait-TestCondition {
                    Assert-TestOwnerAlive $owner
                    Test-Path -LiteralPath (Join-Path $fixtureDirectory 'owner-ready.txt')
                } 'The real owner fixture did not become ready.'
                $initial = Get-TestOwnerSnapshot $fixtureDirectory $owner
                Assert-True (-not $initial.visible -and $initial.responsive) 'The owner must begin hidden with a responsive child.'
                foreach ($mode in @('yes', 'no')) {
                    $duplicate = $null
                    try {
                        $arguments = @('-Launcher', (Join-Path $repository 'scripts/windows-launcher.ps1'), '-ControlDirectory', $fixtureDirectory, '-BackgroundMode', $mode, '-ExpectBlocked', $blockedArgument)
                        $duplicate = Start-TestPowerShell $duplicatePath $arguments
                        Assert-TestPowerShellExit $duplicate ('Duplicate launch failed for ' + $Scenario + ', background=' + $mode + '.')
                    } finally { Stop-TestPowerShell $duplicate }
                    $snapshot = Get-TestOwnerSnapshot $fixtureDirectory $owner
                    if ($mode -eq 'no' -and -not $blocked) {
                        # A named event and ShowWindowAsync both return before
                        # the other UI thread necessarily handles activation.
                        $restoreDeadline = [DateTime]::UtcNow.AddSeconds(10)
                        while ((-not $snapshot.visible -or $snapshot.windowState -ne 'Normal') -and [DateTime]::UtcNow -lt $restoreDeadline) {
                            Start-Sleep -Milliseconds 50
                            $snapshot = Get-TestOwnerSnapshot $fixtureDirectory $owner
                        }
                    }
                    Assert-Equal $snapshot.ownerId $initial.ownerId 'A duplicate replaced the original launcher owner.'
                    Assert-Equal $snapshot.childId $initial.childId 'A duplicate replaced the original child process.'
                    Assert-True ($snapshot.responsive -and -not $snapshot.cancelled -and -not $snapshot.stopped) 'A duplicate interrupted the original launcher or its child.'
                    Assert-Equal $snapshot.marker ('a' * 64) 'A duplicate removed or changed the original instance marker.'
                    Assert-Equal $snapshot.phase $state 'Reopening changed the original launcher state.'
                    if ($mode -eq 'yes' -or $blocked) {
                        Assert-True (-not $snapshot.visible) 'Unattended startup or an unverified duplicate displayed the owner window.'
                    } else {
                        Assert-True ($snapshot.visible -and $snapshot.windowState -eq 'Normal') ('A manual duplicate did not restore the existing hidden or minimized window. ' + ($snapshot | ConvertTo-Json -Compress))
                        Assert-True ($snapshot.nativeVisible -and -not $snapshot.nativeMinimized -and $snapshot.titleNativeVisible -and $snapshot.statusNativeVisible -and $snapshot.actionNativeVisible) ('The restored owner did not display its actual status and action controls. ' + ($snapshot | ConvertTo-Json -Compress))
                        Assert-Equal $snapshot.titleNativeText $snapshot.title ('The restored native title did not match the owner UI. ' + ($snapshot | ConvertTo-Json -Compress))
                        Assert-Equal $snapshot.statusNativeText $snapshot.status ('The restored native status did not match the owner UI. ' + ($snapshot | ConvertTo-Json -Compress))
                        Assert-Equal $snapshot.actionNativeText $snapshot.actionText ('The restored native action button did not match the owner UI. ' + ($snapshot | ConvertTo-Json -Compress))
                        if ($state -eq 'Failed') { Assert-Equal $snapshot.status $initial.status 'Reopening replaced the original failure details.' }
                    }
                }
                if ($blocked) { Assert-True (Test-Path -LiteralPath (Join-Path $fixtureDirectory 'blocked-verified.txt')) 'The blocked duplicate did not exercise Retry and Close safely.' }
                Assert-True (-not (Test-Path -LiteralPath (Join-Path $script:stateRoot 'runtime'))) 'A duplicate began preparing a second private runtime.'
                [IO.File]::WriteAllText((Join-Path $fixtureDirectory 'owner-stop.txt'), 'stop')
                Assert-TestPowerShellExit $owner 'The isolated owner did not shut down cleanly.'
            } finally { Stop-TestPowerShell $owner $fixtureDirectory }
        }
        default { throw ('Unknown launcher test scenario: ' + $Scenario) }
    }
} catch {
    $script:scenarioFailure = $_
    throw
} finally {
    # Cleanup is defensive so a failing assertion cannot leave a fixture running.
    if (Get-Command Stop-ConnectorOwnedProcesses -ErrorAction SilentlyContinue) { Stop-ConnectorOwnedProcesses }
    if (Get-Variable trayIcon -ErrorAction SilentlyContinue) { $trayIcon.Visible = $false; $trayIcon.Dispose() }
    if (Get-Variable trayMenu -ErrorAction SilentlyContinue) { $trayMenu.Dispose() }
    if (Get-Variable form -ErrorAction SilentlyContinue) { $form.Dispose() }
    $env:LOCALAPPDATA = $originalLocalAppData
    if (Test-Path -LiteralPath $temporary) {
        # Windows may still be releasing child-job handles immediately after
        # the owner exits. Retry cleanup, and never replace a useful assertion
        # with a secondary directory-removal error.
        $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while (Test-Path -LiteralPath $temporary) {
            try { Remove-Item -LiteralPath $temporary -Recurse -Force; break }
            catch {
                if ([DateTime]::UtcNow -ge $cleanupDeadline) {
                    if (-not $script:scenarioFailure) { throw }
                    $cleanupMessage = $_.Exception.Message.Replace('%', '%25').Replace("`r", '%0D').Replace("`n", '%0A')
                    Write-Output ('::warning title=Windows launcher fixture cleanup::' + $cleanupMessage)
                    break
                }
                Start-Sleep -Milliseconds 100
            }
        }
    }
}
Write-Output ('Windows launcher scenario passed: ' + $Scenario)
