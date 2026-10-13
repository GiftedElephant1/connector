# Windows PowerShell 5.1; launched by Start Connector.vbs without a console.
# Only this launcher's child processes are stopped. Secrets never enter arguments or logs.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows-common.ps1')
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
New-Item -ItemType Directory -Force -Path $script:stateRoot | Out-Null

# A Windows job also closes npm/build descendants if the launcher is closed.
Add-Type -TypeDefinition @'
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

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Connector'
$form.ClientSize = New-Object System.Drawing.Size(550, 310)
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
$openButton.Add_Click({ if ($script:readyUrl) { Start-Process $script:readyUrl } })
$form.Controls.Add($openButton)

$logButton = New-Object System.Windows.Forms.Button
$logButton.Text = 'View status log'
$logButton.Location = New-Object System.Drawing.Point(182, 182)
$logButton.Size = New-Object System.Drawing.Size(145, 38)
$logButton.Add_Click({ if (Test-Path $script:logPath) { Start-Process notepad.exe -ArgumentList ('"' + $script:logPath + '"') } })
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

$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Text = 'Cancel'
$stopButton.Location = New-Object System.Drawing.Point(381, 182)
$stopButton.Size = New-Object System.Drawing.Size(145, 38)
$stopButton.Add_Click({ $form.Close() })
$form.Controls.Add($stopButton)
$form.Add_FormClosing({ $script:cancelled = $true })

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

$form.Show()
try {
    $script:mutex = New-Object System.Threading.Mutex($false, 'Local\GiftedElephantConnectorDesktop')
    try { $script:mutexOwned = $script:mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $script:mutexOwned = $true }
    if (-not $script:mutexOwned) {
        [void][System.Windows.Forms.MessageBox]::Show('Connector already has a launcher window open. Use Open Connector in that window.', 'Connector', 'OK', 'Information')
        $form.Close()
        return
    }
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
    $instanceHash = Get-TextHash $script:desktopToken
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
            if ($health.Headers['X-Connector-App'] -eq 'gifted-elephant-connector' -and $payload.desktopInstance -eq $instanceHash) { $healthy = $true; break }
        } catch { }
        Wait-Ui
    }
    if (-not $healthy) { throw 'Connector did not finish starting. Close the launcher and try again. Another application may have taken port 3000.' }

    $script:readyUrl = 'http://127.0.0.1:3000/#desktopToken=' + $script:desktopToken
    $title.Text = 'Connector is running'
    Write-Status 'Use the browser to connect your accounts. Keep this window open for scheduled posts and remote access.'
    $progress.Style = 'Continuous'
    $progress.Value = 100
    $openButton.Enabled = $true
    $stopButton.Text = 'Stop Connector'
    Start-Process $script:readyUrl
    $script:readyUrl = 'http://127.0.0.1:3000/'
    $script:desktopToken = $null
    while (-not $script:cancelled) {
        if ($script:child.HasExited) { throw 'Connector has stopped. Close this window and open Start Connector to try again.' }
        Wait-Ui
    }
} catch {
    if (-not $script:cancelled) {
        if ($script:job) { $script:job.Dispose(); $script:job = $null }
        $title.Text = 'Connector needs attention'
        $progress.Visible = $false
        $openButton.Enabled = $false
        $stopButton.Text = 'Close'
        # Known errors are ours; unexpected exception details can include URLs or environment values.
        $message = $_.Exception.Message
        $known = @('Port 3000 ', 'Extract the entire ', 'Connector requires ', 'The official runtime ', 'Runtime download ', 'The extracted runtime ', 'Component installation ', 'Private configuration ', 'The dashboard ', 'The interrupted update ', 'Connector stopped ', 'Connector did not ', 'Connector has stopped.')
        if (-not ($known | Where-Object { $message.StartsWith($_) })) { $message = 'Connector could not complete setup. Check your Internet connection, free disk space, and permission to run applications in this folder, then try again.' }
        Write-Status $message
        while (-not $script:cancelled) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
    }
} finally {
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
    if ($script:job) { $script:job.Dispose() }
    if ($script:child) { $script:child.Dispose() }
    if ($script:mutexOwned) { $script:mutex.ReleaseMutex() }
    if ($script:mutex) { $script:mutex.Dispose() }
    $script:desktopToken = $null
    $script:readyUrl = $null
    $form.Dispose()
}
