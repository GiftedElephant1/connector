# Shared by the desktop launcher and updater. Compatible with Windows PowerShell 5.1.
function Hide-ConnectorLaunchConsole {
    # Signed launchers start visibly so PowerShell can display its normal
    # publisher prompt. Call this only after every launcher helper has loaded.
    # Never hide a console shared with the terminal that started Connector.
    if (-not ('ConnectorLaunchConsole' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class ConnectorLaunchConsole {
    [DllImport("kernel32.dll")]
    static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetConsoleProcessList([Out] uint[] processes, uint count);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr window, int command);

    public static bool HideOwnedConsole() {
        IntPtr window = GetConsoleWindow();
        if (window == IntPtr.Zero) return false;
        var processes = new uint[2];
        if (GetConsoleProcessList(processes, 2) != 1 || processes[0] != (uint)Process.GetCurrentProcess().Id) return false;
        ShowWindow(window, 0); // SW_HIDE, after any signature approval prompts.
        return true;
    }
}
'@
    }
    return [ConnectorLaunchConsole]::HideOwnedConsole()
}

function Get-ConnectorRuntimeSpecification([string]$stateRoot, [string]$processor = '') {
    if (-not $processor) {
        $processor = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $processor = $env:PROCESSOR_ARCHITEW6432 }
    }
    if ($processor -eq 'ARM64') {
        $architecture = 'arm64'
        $archiveSha = '92b9f9b0c0c123e11e4afc535f0ec19cd987465eea506427553a49971364158a'
        $nodeSha = '91e25b2ef61ee30a9e6afce0f336b4d55d688c3717244e496fa11d69fc3a1717'
    } elseif ($processor -eq 'AMD64') {
        $architecture = 'x64'
        $archiveSha = 'ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88'
        $nodeSha = 'd14ba95cdce1ef7dc9ad3ac74949ca5db38b27378ee30f30a23cf26f9e875a11'
    } else { throw 'Connector requires 64-bit Windows 10 or later (Intel/AMD x64 or ARM64).' }

    $version = '24.13.0'
    $runtimeRoot = Join-Path $stateRoot 'runtime'
    $directory = Join-Path $runtimeRoot "node-v$version-win-$architecture"
    return @{
        Version = $version
        Architecture = $architecture
        ArchiveName = "node-v$version-win-$architecture.zip"
        ArchiveSha = $archiveSha
        NodeSha = $nodeSha
        RuntimeRoot = $runtimeRoot
        Directory = $directory
        NodeExe = Join-Path $directory 'node.exe'
    }
}

# ProcessStartInfo.ArgumentList is unavailable in Windows PowerShell 5.1. Quote
# each argument using Windows' backslash-before-quote rules; never invoke a shell.
function ConvertTo-ConnectorArgument([AllowEmptyString()][string]$value) {
    $quoted = New-Object System.Text.StringBuilder
    [void]$quoted.Append([char]34)
    $slashes = 0
    foreach ($character in $value.ToCharArray()) {
        if ($character -eq [char]92) { $slashes++; continue }
        if ($character -eq [char]34) {
            [void]$quoted.Append([char]92, ($slashes * 2 + 1))
        } else {
            [void]$quoted.Append([char]92, $slashes)
        }
        [void]$quoted.Append($character)
        $slashes = 0
    }
    [void]$quoted.Append([char]92, ($slashes * 2))
    [void]$quoted.Append([char]34)
    return $quoted.ToString()
}
