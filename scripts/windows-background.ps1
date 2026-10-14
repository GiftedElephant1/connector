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

function Initialize-ConnectorStartupShortcut {
    if ('ConnectorStartupShortcut' -as [type]) { return }
    # WScript.Shell's shortcut Arguments property can convert Unicode paths to
    # the Windows ANSI code page. Use the Unicode shell-link interface directly
    # so installations in any language remain runnable after Windows sign-in.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class ConnectorStartupShortcut {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int length, IntPtr findData, uint flags);
        void GetIDList(out IntPtr pidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder description, int length);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string description);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int length);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int length);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);
        void GetHotkey(out short hotkey);
        void SetHotkey(short hotkey);
        void GetShowCmd(out int show);
        void SetShowCmd(int show);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int length, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    public static void Save(string file, string target, string arguments, string workingDirectory) {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        try {
            link.SetPath(target);
            link.SetArguments(arguments);
            link.SetWorkingDirectory(workingDirectory);
            link.SetShowCmd(7);
            link.SetDescription("Run Connector in the notification area when you sign in to Windows.");
            ((IPersistFile)link).Save(file, true);
        } finally { Marshal.FinalReleaseComObject(link); }
    }

    public static string[] Read(string file) {
        IShellLinkW link = (IShellLinkW)new ShellLink();
        try {
            ((IPersistFile)link).Load(file, 0);
            StringBuilder target = new StringBuilder(32768);
            StringBuilder arguments = new StringBuilder(32768);
            StringBuilder directory = new StringBuilder(32768);
            link.GetPath(target, target.Capacity, IntPtr.Zero, 0);
            link.GetArguments(arguments, arguments.Capacity);
            link.GetWorkingDirectory(directory, directory.Capacity);
            return new string[] { target.ToString(), arguments.ToString(), directory.ToString() };
        } finally { Marshal.FinalReleaseComObject(link); }
    }
}
'@
}

function Get-ConnectorStartupShortcutMetadata([string]$path) {
    Initialize-ConnectorStartupShortcut
    $metadata = [ConnectorStartupShortcut]::Read($path)
    return @{ TargetPath = $metadata[0]; Arguments = $metadata[1]; WorkingDirectory = $metadata[2] }
}

function Get-ConnectorStartWithWindows([string]$root, [string]$startupDirectory = '') {
    $shortcutPath = Get-ConnectorStartupPath $startupDirectory
    if (-not (Test-Path -LiteralPath $shortcutPath)) { return $false }
    $shortcut = Get-ConnectorStartupShortcutMetadata $shortcutPath
    $expectedTarget = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $expectedArguments = (ConvertTo-ConnectorArgument (Join-Path $root 'Start Connector.vbs')) + ' /background'
    return $shortcut.TargetPath -eq $expectedTarget -and $shortcut.Arguments -eq $expectedArguments
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
    Initialize-ConnectorStartupShortcut
    [ConnectorStartupShortcut]::Save($shortcutPath, (Join-Path $env:SystemRoot 'System32\wscript.exe'), ((ConvertTo-ConnectorArgument $launcher) + ' /background'), $root)
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

# The mutex still decides which process may run or update Connector. This
# separate, session-local event only asks that owner to reveal its status UI.
function New-ConnectorShowSignal {
    return New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, 'Local\GiftedElephantConnectorShowStatus')
}

function Send-ConnectorShowSignal {
    $signal = $null
    try {
        $signal = [System.Threading.EventWaitHandle]::OpenExisting('Local\GiftedElephantConnectorShowStatus')
        return $signal.Set()
    } catch { return $false }
    finally { if ($signal) { $signal.Dispose() } }
}

function Start-ConnectorShowListener([scriptblock]$show) {
    $signal = New-ConnectorShowSignal
    $timer = New-Object System.Windows.Forms.Timer
    try {
        $timer.Interval = 150
        # WinForms timers run on the same thread as DoEvents/ShowDialog. No
        # background runspace may touch these controls or the owned mutex.
        $tick = {
            try { if ($signal.WaitOne(0)) { & $show } }
            catch [System.ObjectDisposedException] { }
        }.GetNewClosure()
        $timer.Add_Tick($tick)
        $timer.Start()
        return @{ Signal = $signal; Timer = $timer }
    } catch {
        $timer.Dispose()
        $signal.Dispose()
        throw
    }
}

function Stop-ConnectorShowListener($listener) {
    if (-not $listener) { return }
    $listener.Timer.Stop()
    $listener.Timer.Dispose()
    $listener.Signal.Dispose()
}

function Initialize-ConnectorWindowActivation {
    if ('ConnectorWindowActivation' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ConnectorWindowActivation {
    public sealed class WindowInfo {
        public IntPtr Handle;
        public uint ProcessId;
        public string Title;
        public string ClassName;
    }
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int maximum);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int maximum);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr parameter, IntPtr extra, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr window);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr memory);

    public static WindowInfo[] FindWindows(int excludedProcessId) {
        var windows = new List<WindowInfo>();
        // EnumWindows includes hidden and minimized forms, unlike MainWindowHandle.
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId == excludedProcessId) return true;
            var title = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            if (title.ToString() != "Connector" && title.ToString() != "Update Connector") return true;
            var className = new StringBuilder(256);
            GetClassName(window, className, className.Capacity);
            if (!className.ToString().StartsWith("WindowsForms10.Window.", StringComparison.Ordinal)) return true;
            windows.Add(new WindowInfo { Handle = window, ProcessId = processId, Title = title.ToString(), ClassName = className.ToString() });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static string[] Arguments(string commandLine) {
        int count;
        IntPtr arguments = CommandLineToArgvW(commandLine, out count);
        if (arguments == IntPtr.Zero) return new string[0];
        try {
            var result = new string[count];
            for (int index = 0; index < count; index++) result[index] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(arguments, index * IntPtr.Size));
            return result;
        } finally { LocalFree(arguments); }
    }

    public static bool Show(IntPtr window) {
        if (!IsWindow(window)) return false;
        // SW_RESTORE alone can reveal the HWND without WM_SHOWWINDOW, leaving
        // WinForms Visible=false and its controls uncreated on an old launcher.
        ShowWindowAsync(window, 5); // SW_SHOW initializes managed visibility.
        ShowWindowAsync(window, 9); // SW_RESTORE normalizes a minimized form.
        // Both requests are asynchronous. Wait briefly for the native restore
        // before initializing managed visibility, so STARTUPINFO cannot undo it.
        var restoreWait = System.Diagnostics.Stopwatch.StartNew();
        while (!IsWindowVisible(window) || IsIconic(window)) {
            if (!IsWindow(window) || restoreWait.ElapsedMilliseconds >= 1000) return false;
            System.Threading.Thread.Sleep(25);
        }
        // WinForms itself forces this first-show notification when STARTUPINFO
        // suppresses it (our VBS launches PowerShell hidden). Let its own window
        // procedure set Visible and CreateControl; never hang on a stuck owner.
        UIntPtr result;
        if (SendMessageTimeout(window, 0x0018, new IntPtr(1), IntPtr.Zero, 0x0002, 1500, out result) == IntPtr.Zero) return false;
        SetForegroundWindow(window); // Windows may instead flash its taskbar button.
        return true;
    }
}
'@
}

function Test-ConnectorWindowOwner($process, [string]$title) {
    if (-not $process -or -not $process.CommandLine -or -not $process.ExecutablePath) { return $false }
    if ($title -ne 'Connector' -and $title -ne 'Update Connector') { return $false }
    # Only the Windows PowerShell executable used by our launchers qualifies.
    $executables = @(
        (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'),
        (Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe')
    )
    if ($executables -inotcontains $process.ExecutablePath) { return $false }
    Initialize-ConnectorWindowActivation
    $arguments = [ConnectorWindowActivation]::Arguments($process.CommandLine)
    for ($index = 1; $index -lt $arguments.Length - 1; $index++) {
        $argument = $arguments[$index]
        if (@('-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-MTA') -icontains $argument) { continue }
        if ($argument -ieq '-ExecutionPolicy' -or $argument -ieq '-WindowStyle') {
            $index++
            if ($argument -ieq '-ExecutionPolicy' -and @('Bypass', 'AllSigned') -inotcontains $arguments[$index]) { return $false }
            if ($argument -ieq '-WindowStyle' -and @('Hidden', 'Normal', 'Minimized', 'Maximized') -inotcontains $arguments[$index]) { return $false }
            continue
        }
        # Do not mistake -File appearing inside -Command/-c or an arbitrary
        # script argument for PowerShell actually executing one of our scripts.
        if ($argument -ine '-File') { return $false }
        $path = $arguments[$index + 1]
        $expectedFile = if ($title -eq 'Connector') { 'windows-launcher.ps1' } else { 'windows-update.ps1' }
        try {
            return [IO.Path]::IsPathRooted($path) -and
                [IO.Path]::GetFileName($path) -ieq $expectedFile -and
                [IO.Path]::GetFileName([IO.Path]::GetDirectoryName($path)) -ieq 'scripts'
        } catch { return $false }
    }
    return $false
}

function Show-ConnectorExistingWindow {
    try {
        Initialize-ConnectorWindowActivation
        foreach ($window in [ConnectorWindowActivation]::FindWindows($PID)) {
            # Older releases lack the event listener. Verify the exact title,
            # WinForms class, executable and -File argument before restoring one.
            $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $window.ProcessId) -ErrorAction Stop
            if ((Test-ConnectorWindowOwner $process $window.Title) -and [ConnectorWindowActivation]::Show($window.Handle)) { return $true }
        }
    } catch { }
    return $false
}

function Request-ConnectorExistingWindow {
    # The listener belongs to the lock owner. An idle updater or recovery
    # window may also exist, so only search older windows if no listener exists.
    if (Send-ConnectorShowSignal) { return $true }
    return Show-ConnectorExistingWindow
}
