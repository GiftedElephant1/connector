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
