# Windows PowerShell 5.1; launched by Start Connector.vbs without a console.
# Only this launcher's child processes are stopped. Secrets never enter arguments or logs.
param([switch]$Background, [switch]$InitializeOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
. (Join-Path $PSScriptRoot 'windows-background.ps1')
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:root = Split-Path -Parent $PSScriptRoot
$script:stateRoot = Join-Path $env:LOCALAPPDATA 'Connector'
$script:logPath = Join-Path $script:stateRoot 'launcher.log'
$script:child = $null
$script:cancelled = $false
$script:readyUrl = $null
$script:job = $null
$script:mutex = $null
$script:mutexOwned = $false
$script:desktopToken = $null
$script:phase = 'Starting'
$script:stopRequested = $false
$script:instanceHash = $null
$script:startupUpdating = $false
$script:backgroundStart = [bool]$Background
$script:showListener = $null
New-Item -ItemType Directory -Force -Path $script:stateRoot | Out-Null

# The invisible launcher owns the job for its entire lifetime, including when
# the status window is hidden. Explicit Stop and Windows shutdown close it.
if (-not ('ConnectorChildJob' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public sealed class ConnectorChildJob : IDisposable {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);
    IntPtr handle;
    public ConnectorChildJob() {
        handle = CreateJobObject(IntPtr.Zero, null);
        if (handle == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.BasicLimitInformation.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
        int size = Marshal.SizeOf(typeof(ExtendedLimits));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(handle, 9, pointer, (uint)size)) throw new Win32Exception();
        } catch { CloseHandle(handle); handle = IntPtr.Zero; throw; }
        finally { Marshal.FreeHGlobal(pointer); }
    }
    public void Add(IntPtr process) {
        if (!AssignProcessToJobObject(handle, process)) throw new Win32Exception();
    }
    public void Dispose() {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }
}
'@
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Connector'
$form.ClientSize = New-Object System.Drawing.Size(550, 345)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$title = New-Object System.Windows.Forms.Label
$title.Text = 'Starting Connector'
$title.Font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$title.Location = New-Object System.Drawing.Point(24, 20)
$title.Size = New-Object System.Drawing.Size(502, 36)
$form.Controls.Add($title)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Preparing your private workspace...'
$status.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$status.Location = New-Object System.Drawing.Point(24, 70)
$status.Size = New-Object System.Drawing.Size(502, 62)
$form.Controls.Add($status)

$progress = New-Object System.Windows.Forms.ProgressBar
$progress.Style = 'Marquee'
$progress.Location = New-Object System.Drawing.Point(24, 145)
$progress.Size = New-Object System.Drawing.Size(502, 12)
$form.Controls.Add($progress)

$openButton = New-Object System.Windows.Forms.Button
$openButton.Text = 'Open Connector'
$openButton.Location = New-Object System.Drawing.Point(24, 182)
$openButton.Size = New-Object System.Drawing.Size(145, 38)
$openButton.Enabled = $false
$openButton.Add_Click({
    if ($script:phase -eq 'Existing') { Retry-ConnectorExistingInstance }
    else { Open-ConnectorDashboard }
})
$form.Controls.Add($openButton)

$logButton = New-Object System.Windows.Forms.Button
$logButton.Text = 'View status log'
$logButton.Location = New-Object System.Drawing.Point(182, 182)
$logButton.Size = New-Object System.Drawing.Size(145, 38)
$logButton.Add_Click({ Open-ConnectorLog })
$form.Controls.Add($logButton)

$updateButton = New-Object System.Windows.Forms.Button
$updateButton.Text = 'Get updates'
$updateButton.Location = New-Object System.Drawing.Point(24, 238)
$updateButton.Size = New-Object System.Drawing.Size(145, 38)
$updateButton.Add_Click({
    [void][System.Windows.Forms.MessageBox]::Show(
        "Download Connector-Windows from the newest successful Package Windows app run. Extract both ZIP layers.`r`n`r`nThen click Stop Connector here. Open Update Connector in the NEW download and choose this EXISTING Connector folder to keep your connected accounts and settings.`r`n`r`nExisting folder:`r`n" + $script:root,
        'Update without reconnecting accounts', 'OK', 'Information')
    Start-Process 'https://github.com/GiftedElephant1/connector/actions/workflows/windows-release.yml'
})
$form.Controls.Add($updateButton)

$hideButton = New-Object System.Windows.Forms.Button
$hideButton.Text = 'Hide to tray'
$hideButton.Location = New-Object System.Drawing.Point(182, 238)
$hideButton.Size = New-Object System.Drawing.Size(145, 38)
$hideButton.Enabled = $false
$hideButton.Add_Click({ Hide-ConnectorWindow })
$form.Controls.Add($hideButton)

$startupCheckbox = New-Object System.Windows.Forms.CheckBox
$startupCheckbox.Text = 'Start with Windows (when I sign in)'
$startupCheckbox.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$startupCheckbox.Location = New-Object System.Drawing.Point(24, 298)
$startupCheckbox.Size = New-Object System.Drawing.Size(400, 25)
$startupCheckbox.Enabled = $false
$startupCheckbox.Add_CheckedChanged({ if (-not $script:startupUpdating) { Update-ConnectorStartup $startupCheckbox.Checked } })
$form.Controls.Add($startupCheckbox)

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Text = 'Cancel'
$stopButton.Location = New-Object System.Drawing.Point(381, 182)
$stopButton.Size = New-Object System.Drawing.Size(145, 38)
$stopButton.Add_Click({ Request-ConnectorStop })
$form.Controls.Add($stopButton)

$trayMenu = New-Object System.Windows.Forms.ContextMenuStrip
$trayOpen = $trayMenu.Items.Add('Open Connector')
$trayOpen.Enabled = $false
$trayOpen.Add_Click({ Open-ConnectorDashboard })
$trayStatus = $trayMenu.Items.Add('Show status')
$trayStatus.Add_Click({ Show-ConnectorWindow })
$trayLog = $trayMenu.Items.Add('View status log')
$trayLog.Add_Click({ Open-ConnectorLog })
[void]$trayMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$trayStartup = $trayMenu.Items.Add('Start with Windows')
$trayStartup.Enabled = $false
$trayStartup.CheckOnClick = $true
$trayStartup.Add_Click({ if (-not $script:startupUpdating) { Update-ConnectorStartup $trayStartup.Checked } })
[void]$trayMenu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$trayStop = $trayMenu.Items.Add('Stop Connector')
$trayStop.Add_Click({ Request-ConnectorStop })

$trayIcon = New-Object System.Windows.Forms.NotifyIcon
$trayIcon.Icon = [System.Drawing.SystemIcons]::Application
$trayIcon.Text = 'Connector - starting'
$trayIcon.ContextMenuStrip = $trayMenu
$trayIcon.Visible = $false
$trayIcon.Add_DoubleClick({ if ($script:phase -eq 'Running') { Open-ConnectorDashboard } else { Show-ConnectorWindow } })

$form.Add_FormClosing({
    param($sender, $eventArgs)
    if ((Get-ConnectorCloseAction $script:phase ([string]$eventArgs.CloseReason) $script:stopRequested) -eq 'Hide') {
        $eventArgs.Cancel = $true
        Hide-ConnectorWindow
    } else { $script:cancelled = $true }
})
$form.Add_Resize({
    if ($script:phase -eq 'Running' -and $form.WindowState -eq 'Minimized') { Hide-ConnectorWindow }
})

function Open-ConnectorDashboard {
    if ($script:readyUrl) { Start-Process $script:readyUrl }
}

function Open-ConnectorLog {
    if (Test-Path -LiteralPath $script:logPath) { Start-Process notepad.exe -ArgumentList (ConvertTo-ConnectorArgument $script:logPath) }
}

function Show-ConnectorWindow {
    if ($script:cancelled -or $form.IsDisposed) { return }
    # Changing ShowInTaskbar recreates the native handle. Normalize first so
    # that recreation cannot run the minimize-to-tray handler again.
    $form.WindowState = 'Normal'
    $form.ShowInTaskbar = $true
    $form.Show()
    [void]$form.Activate()
}

function Open-ConnectorExistingInstance {
    if (Test-ConnectorExistingInstance (Get-ConnectorInstanceHash $script:stateRoot)) {
        try { Start-Process 'http://127.0.0.1:3000/'; return $true }
        catch { } # If Windows cannot open a browser, reveal the owner's controls.
    }
    return Request-ConnectorExistingWindow
}

function Try-ConnectorInstanceMutex {
    if ($script:mutexOwned) { return $true }
    try { $script:mutexOwned = $script:mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $script:mutexOwned = $true }
    return $script:mutexOwned
}

function Retry-ConnectorExistingInstance {
    $openButton.Enabled = $false
    try {
        if (Open-ConnectorExistingInstance) { Request-ConnectorStop; return }
        # A previous owner may have closed since the first attempt. Starting is
        # safe only after this process actually acquires the same instance lock.
        if (Try-ConnectorInstanceMutex) { $form.Hide(); return }
        $status.Text = 'The existing Connector window is not responding yet. Try again shortly or open View status log. If an update is running, let it finish. If no update is running and this continues, restart Windows, then open Start Connector.'
    } finally { if (-not $script:cancelled -and -not $script:mutexOwned) { $openButton.Enabled = $true } }
}

function Show-ConnectorExistingStatus {
    $script:phase = 'Existing'
    $title.Text = 'Connector is already open'
    $status.Text = 'Another Connector launch or update is active, but its window could not be opened yet. Click Retry opening Connector or View status log. If an update is running, let it finish. Your accounts and the existing process have not been changed.'
    $status.Height = 72
    $progress.Visible = $false
    $openButton.Text = 'Retry opening Connector'
    $openButton.Enabled = $true
    $updateButton.Enabled = $false
    $stopButton.Text = 'Close'
    Show-ConnectorWindow
}

function Set-ConnectorStartingStatus {
    $script:phase = 'Starting'
    $title.Text = 'Starting Connector'
    $status.Text = 'Preparing your private workspace...'
    $status.Height = 62
    $progress.Visible = $true
    $openButton.Text = 'Open Connector'
    $openButton.Enabled = $false
    $updateButton.Enabled = $true
    $stopButton.Text = 'Cancel'
}

function Hide-ConnectorWindow {
    if ($script:phase -ne 'Running') { return }
    $trayIcon.Visible = $true
    $form.Hide()
    $form.ShowInTaskbar = $false
}

function Request-ConnectorStop {
    $script:stopRequested = $true
    $script:phase = 'Stopping'
    $form.Close()
    # A never-shown form during sign-in startup can close without FormClosing.
    $script:cancelled = $true
}

function Sync-ConnectorStartupControls([bool]$enabled) {
    $script:startupUpdating = $true
    try { $startupCheckbox.Checked = $enabled; $trayStartup.Checked = $enabled }
    finally { $script:startupUpdating = $false }
}

function Update-ConnectorStartup([bool]$enabled) {
    try {
        Set-ConnectorStartWithWindows $script:root $enabled
        Sync-ConnectorStartupControls (Get-ConnectorStartWithWindows $script:root)
    } catch {
        try { Sync-ConnectorStartupControls (Get-ConnectorStartWithWindows $script:root) } catch { Sync-ConnectorStartupControls $false }
        [void][System.Windows.Forms.MessageBox]::Show('Windows could not change the startup setting. Check that this folder still contains Start Connector and that your account can update its Startup folder. Connector can still be started manually.', 'Connector startup', 'OK', 'Warning')
    }
}

function Set-ConnectorReady {
    $script:phase = 'Running'
    $script:readyUrl = 'http://127.0.0.1:3000/'
    $title.Text = 'Connector is running in the background'
    $title.Font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
    Write-Status 'You can close this window and your browser. Scheduled posts and remote access continue while this PC is on and awake. Use the Connector tray icon to reopen or stop it.'
    if ($script:cancelled) { $script:desktopToken = $null; return }
    $progress.Style = 'Continuous'
    $progress.Value = 100
    $openButton.Enabled = $true
    $hideButton.Enabled = $true
    $trayOpen.Enabled = $true
    $trayIcon.Text = 'Connector - running'
    $stopButton.Text = 'Stop Connector'
    $startupCheckbox.Enabled = $true
    $trayStartup.Enabled = $true
    if ($script:backgroundStart) { Hide-ConnectorWindow }
    else {
        # The initial one-use local sign-in link is opened only for an explicit
        # user launch. Nothing sensitive is written to the instance marker.
        if ($script:desktopToken) { $script:readyUrl += '#desktopToken=' + $script:desktopToken }
        try { Open-ConnectorDashboard }
        finally { $script:readyUrl = 'http://127.0.0.1:3000/' }
    }
    $script:desktopToken = $null
}

function Set-ConnectorFailure([string]$message) {
    $script:phase = 'Failed'
    $script:readyUrl = $null
    $title.Text = 'Connector needs attention'
    $progress.Visible = $false
    $openButton.Enabled = $false
    $hideButton.Enabled = $false
    $trayOpen.Enabled = $false
    $trayIcon.Text = 'Connector - needs attention'
    $trayIcon.Icon = [System.Drawing.SystemIcons]::Warning
    $stopButton.Text = 'Close'
    Write-Status $message
    if (-not $script:cancelled) { Show-ConnectorWindow }
}

function Write-Status([string]$message) {
    $status.Text = $message
    # Only our fixed status messages are logged, never subprocess output or credentials.
    Add-Content -LiteralPath $script:logPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $message.Replace("`r", ' ').Replace("`n", ' '))
    [System.Windows.Forms.Application]::DoEvents()
}

function Wait-Ui {
    [System.Windows.Forms.Application]::DoEvents()
    if ($script:cancelled) { throw 'Launch cancelled.' }
    Start-Sleep -Milliseconds 100
}

function Get-File([string]$url, [string]$destination) {
    $client = New-Object System.Net.WebClient
    try {
        $pending = $client.DownloadFileTaskAsync([Uri]$url, $destination)
        while (-not $pending.IsCompleted) { Wait-Ui }
        $pending.GetAwaiter().GetResult()
    } finally { $client.Dispose() }
}

function Start-OwnedNode([string]$arguments, [hashtable]$extraEnv = @{}) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:nodeExe
    $info.Arguments = $arguments
    $info.WorkingDirectory = $script:root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.RedirectStandardInput = $true
    $info.EnvironmentVariables['PATH'] = $script:nodeDirectory + ';' + $env:PATH
    $info.EnvironmentVariables['npm_config_cache'] = Join-Path $script:stateRoot 'npm-cache'
    foreach ($key in $extraEnv.Keys) { $info.EnvironmentVariables[$key] = [string]$extraEnv[$key] }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    [void]$process.Start()
    try { $script:job.Add($process.Handle) }
    catch { if (-not $process.HasExited) { $process.Kill() }; $process.Dispose(); throw }
    # Drain pipes asynchronously without displaying or writing potentially sensitive output.
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    return @{ Process = $process; Output = $output; Errors = $errors }
}

function Run-NodeStep([string]$arguments, [string]$failure) {
    $run = Start-OwnedNode $arguments
    try {
        while (-not $run.Process.HasExited) { Wait-Ui }
        $run.Process.WaitForExit()
        if ($run.Process.ExitCode -ne 0) { throw $failure }
    } finally { $run.Process.Dispose() }
}

function Get-TextHash([string]$value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Stop-ConnectorOwnedProcesses {
    if ($script:job -and $script:child -and -not $script:child.HasExited) {
        try {
            $script:child.StandardInput.WriteLine('stop')
            $script:child.StandardInput.Flush()
            $stopDeadline = [DateTime]::UtcNow.AddSeconds(5)
            while (-not $script:child.HasExited -and [DateTime]::UtcNow -lt $stopDeadline) {
                [System.Windows.Forms.Application]::DoEvents()
                Start-Sleep -Milliseconds 100
            }
        } catch { }
    }
    try { if ($script:job) { $script:job.Dispose() } }
    finally {
        $script:job = $null
        if ($script:child) { $script:child.Dispose(); $script:child = $null }
    }
}

# Tests initialize the same controls and handlers without launching a runtime,
# changing Startup, acquiring the instance mutex, or writing instance state.
if ($InitializeOnly) { return }

# A hidden form still needs a native handle to receive Windows logoff/shutdown.
$null = $form.Handle
try {
    $script:mutex = New-Object System.Threading.Mutex($false, 'Local\GiftedElephantConnectorDesktop')
    if (-not (Try-ConnectorInstanceMutex)) {
        if ($script:backgroundStart -or (Open-ConnectorExistingInstance)) {
            Request-ConnectorStop
            return
        }
        # No speculative Starting window or blocking modal obscures the owner.
        # If it cannot be reached, provide a normal retry/log window instead.
        Show-ConnectorExistingStatus
        while (-not $script:cancelled -and -not $script:mutexOwned) { Wait-Ui }
        if ($script:cancelled) { return }
    }
    $script:showListener = Start-ConnectorShowListener { Show-ConnectorWindow }
    Set-ConnectorStartingStatus
    if (-not $script:backgroundStart) { $form.Show() }
    $markerPath = Join-Path $script:stateRoot 'desktop-instance.txt'
    if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force }
    $trayIcon.Visible = $true
    try { Sync-ConnectorStartupControls (Get-ConnectorStartWithWindows $script:root) } catch { Sync-ConnectorStartupControls $false }
    $startupCheckbox.Enabled = $true
    $trayStartup.Enabled = $true
    Set-Content -LiteralPath $script:logPath -Value 'Connector launch status. Credentials and server output are omitted.'
    $script:job = New-Object ConnectorChildJob
    if (-not (Test-Path (Join-Path $script:root 'package-lock.json'))) { throw 'Extract the entire Connector ZIP before opening Start Connector.' }

    # Reserve-check the chosen loopback port; never attach to or stop an unrelated server.
    $probe = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 3000)
    try { $probe.Start() }
    catch { throw 'Port 3000 is already in use. Close the other Connector instance or application using it, then open Start Connector again.' }
    finally { $probe.Stop() }

    $runtime = Get-ConnectorRuntimeSpecification $script:stateRoot
    $architecture = $runtime.Architecture
    $archiveSha = $runtime.ArchiveSha
    $nodeSha = $runtime.NodeSha
    $nodeVersion = $runtime.Version
    $archiveName = $runtime.ArchiveName
    $runtimeRoot = $runtime.RuntimeRoot
    $script:nodeDirectory = $runtime.Directory
    $script:nodeExe = $runtime.NodeExe
    $runtimeReady = (Test-Path $script:nodeExe) -and ((Get-FileHash -LiteralPath $script:nodeExe -Algorithm SHA256).Hash.ToLowerInvariant() -eq $nodeSha)
    if (-not $runtimeReady) {
        Write-Status 'Downloading the private runtime from nodejs.org. The first launch needs an Internet connection.'
        New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
        $downloadRoot = Join-Path $runtimeRoot ('download-' + [Guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $downloadRoot | Out-Null
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
            $checksums = Join-Path $downloadRoot 'SHASUMS256.txt'
            $archive = Join-Path $downloadRoot $archiveName
            Get-File "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" $checksums
            $expectedLine = $archiveSha + '  ' + $archiveName
            if (-not ((Get-Content -LiteralPath $checksums) -contains $expectedLine)) { throw 'The official runtime checksum does not match this release. Download a fresh Connector release.' }
            Get-File "https://nodejs.org/dist/v$nodeVersion/$archiveName" $archive
            if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $archiveSha) { throw 'Runtime download verification failed. Check your connection and try again.' }
            Write-Status 'Verifying and installing the private runtime...'
            Expand-Archive -LiteralPath $archive -DestinationPath $downloadRoot
            $extracted = Join-Path $downloadRoot "node-v$nodeVersion-win-$architecture"
            if ((Get-FileHash -LiteralPath (Join-Path $extracted 'node.exe') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $nodeSha) { throw 'The extracted runtime failed verification. Download a fresh Connector release.' }
            if (Test-Path $script:nodeDirectory) { Remove-Item -LiteralPath $script:nodeDirectory -Recurse -Force }
            Move-Item -LiteralPath $extracted -Destination $script:nodeDirectory
        } finally { if (Test-Path $downloadRoot) { Remove-Item -LiteralPath $downloadRoot -Recurse -Force } }
    }

    if (Test-Path -LiteralPath (Join-Path $script:root '.connector-update\journal.json')) {
        Write-Status 'Recovering an interrupted update before opening your saved accounts...'
        Run-NodeStep 'scripts/update.mjs --recover-only --target .' 'The interrupted update could not be recovered. Open Update Connector from the new download and select this existing folder to try recovery again.'
    }

    $npmCli = Join-Path $script:nodeDirectory 'node_modules\npm\bin\npm-cli.js'
    $lockHash = (Get-FileHash -LiteralPath (Join-Path $script:root 'package-lock.json') -Algorithm SHA256).Hash
    $installStamp = Join-Path $script:root 'node_modules\.connector-install'
    if (-not (Test-Path $installStamp) -or (Get-Content -LiteralPath $installStamp -Raw).Trim() -ne "$nodeVersion-$architecture-$lockHash") {
        Write-Status 'Installing Connector components. This may take several minutes on the first launch.'
        Run-NodeStep ('"' + $npmCli + '" ci --no-audit --no-fund') 'Component installation failed. Check your Internet connection and available disk space, then try again.'
        Set-Content -LiteralPath $installStamp -Value "$nodeVersion-$architecture-$lockHash"
    }

    Write-Status 'Preparing private account storage...'
    Run-NodeStep 'scripts/setup.mjs' 'Private configuration could not be prepared. Extract Connector into a folder where your Windows account can save files.'

    # Hash inputs so updates rebuild automatically, including source changes with an unchanged lockfile.
    $inputFiles = @(Get-ChildItem -LiteralPath (Join-Path $script:root 'client'), (Join-Path $script:root 'server') -File -Recurse)
    $inputFiles += Get-Item -LiteralPath (Join-Path $script:root 'package.json'), (Join-Path $script:root 'tsconfig.json'), (Join-Path $script:root 'vite.config.ts')
    $inputHashes = ($inputFiles | Sort-Object FullName | ForEach-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }) -join ':'
    $buildHash = Get-TextHash ($lockHash + ':' + $inputHashes)
    $buildStamp = Join-Path $script:root 'dist\.connector-build'
    if (-not (Test-Path $buildStamp) -or (Get-Content -LiteralPath $buildStamp -Raw).Trim() -ne $buildHash) {
        Write-Status 'Preparing the dashboard. Later launches will be faster.'
        Run-NodeStep ('"' + $npmCli + '" run build') 'The dashboard could not be prepared. Download and extract a fresh Connector release, or open View status log for the failed stage.'
        Set-Content -LiteralPath $buildStamp -Value $buildHash
    }

    Write-Status 'Starting your private Connector...'
    $bytes = New-Object byte[] 32
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $random.GetBytes($bytes) } finally { $random.Dispose() }
    $script:desktopToken = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    $script:instanceHash = Get-TextHash $script:desktopToken
    $run = Start-OwnedNode '--import tsx server/index.ts' @{
        CONNECTOR_DESKTOP_TOKEN = $script:desktopToken
        HOST = '127.0.0.1'
        PORT = '3000'
    }
    $script:child = $run.Process
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $healthy = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($script:child.HasExited) { throw 'Connector stopped during startup. An old configuration may need attention; your saved data has been preserved.' }
        try {
            $health = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/api/health' -UseBasicParsing -TimeoutSec 1
            $payload = $health.Content | ConvertFrom-Json
            if ($health.Headers['X-Connector-App'] -eq 'gifted-elephant-connector' -and $payload.desktopInstance -eq $script:instanceHash) { $healthy = $true; break }
        } catch { }
        Wait-Ui
    }
    if (-not $healthy) { throw 'Connector did not finish starting. Close this status window and try again. Another application may have taken port 3000.' }

    # The marker contains only a non-secret identity hash, never the one-use
    # desktop sign-in link. Duplicate launches validate it before opening localhost.
    Set-Content -LiteralPath $markerPath -Value $script:instanceHash -Encoding ASCII
    Set-ConnectorReady
    while (-not $script:cancelled) {
        if ($script:child.HasExited) { throw 'Connector has stopped. Close this window and open Start Connector to try again.' }
        Wait-Ui
    }
} catch {
    if (-not $script:cancelled) {
        if ($script:job) { $script:job.Dispose(); $script:job = $null }
        # Known errors are ours; unexpected exception details can include URLs or environment values.
        $message = $_.Exception.Message
        $known = @('Port 3000 ', 'Extract the entire ', 'Connector requires ', 'The official runtime ', 'Runtime download ', 'The extracted runtime ', 'Component installation ', 'Private configuration ', 'The dashboard ', 'The interrupted update ', 'Connector stopped ', 'Connector did not ', 'Connector has stopped.')
        if (-not ($known | Where-Object { $message.StartsWith($_) })) { $message = 'Connector could not complete setup. Check your Internet connection, free disk space, and permission to run applications in this folder, then try again.' }
        Set-ConnectorFailure $message
        while (-not $script:cancelled) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
    }
} finally {
    Stop-ConnectorShowListener $script:showListener
    $script:showListener = $null
    Stop-ConnectorOwnedProcesses
    if ($script:mutexOwned) {
        $markerPath = Join-Path $script:stateRoot 'desktop-instance.txt'
        if (Test-Path -LiteralPath $markerPath) { Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue }
    }
    $trayIcon.Visible = $false
    $trayIcon.Dispose()
    $trayMenu.Dispose()
    if ($script:mutexOwned) { $script:mutex.ReleaseMutex() }
    if ($script:mutex) { $script:mutex.Dispose() }
    $script:desktopToken = $null
    $script:readyUrl = $null
    $form.Dispose()
}
