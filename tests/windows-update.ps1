# Runs with Windows PowerShell 5.1 in CI, or portable PowerShell for local checks.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
. (Join-Path $repository 'scripts/windows-common.ps1')

function Assert-Equal($actual, $expected, [string]$message) {
    if (-not [String]::Equals([string]$actual, [string]$expected, [StringComparison]::Ordinal)) { throw $message }
}

$nodeExe = (Get-Command node -ErrorAction Stop).Source
$unicodeFolder = 'Cloud ' + [char]0x540c + [char]0x6b65
$cases = @('C:\Users\Space User\Connector\', ("C:\Users\O'Brien\" + $unicodeFolder + '\Connector'), 'a"quoted"argument', '', '--target', 'slash\"quote', '\\server\share\')
$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $nodeExe
$arguments = @('-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '--') + $cases
$info.Arguments = ($arguments | ForEach-Object { ConvertTo-ConnectorArgument $_ }) -join ' '
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
$process = New-Object System.Diagnostics.Process
$process.StartInfo = $info
try {
    [void]$process.Start()
    $result = @($process.StandardOutput.ReadToEnd() | ConvertFrom-Json)
    $process.WaitForExit()
    Assert-Equal $process.ExitCode 0 'The argument round-trip child failed.'
    Assert-Equal $result.Count $cases.Count 'Argument quoting lost an empty argument.'
    for ($index = 0; $index -lt $cases.Count; $index++) { Assert-Equal $result[$index] $cases[$index] 'A Windows path or argument was changed before reaching Node.' }
} finally { $process.Dispose() }

# Execute the actual updater-to-engine bridge without opening a desktop window.
$parseErrors = $null
$tokens = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $repository 'scripts/windows-update.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) { throw 'The Windows updater has a syntax error.' }
$bridge = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-UpdateEngine' }, $true)
if (-not $bridge) { throw 'The updater engine bridge was not found.' }
Invoke-Expression $bridge.Extent.Text
if (-not ('System.Windows.Forms.Application' -as [type])) {
    Add-Type -TypeDefinition 'namespace System.Windows.Forms { public static class Application { public static void DoEvents() {} } }'
}
$script:messages = New-Object 'System.Collections.Generic.List[string]'
function Set-UpdateStatus([string]$message) { $script:messages.Add($message) }
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('connector updater ' + [Guid]::NewGuid().ToString('N'))
$script:sourceRoot = Join-Path $temporary ("O'Brien " + $unicodeFolder)
$script:stateRoot = Join-Path $temporary 'private state'
$script:runtime = @{ NodeExe = $nodeExe; Directory = Split-Path -Parent $nodeExe }
$script:failureMessage = 'Generic failure'
try {
    New-Item -ItemType Directory -Path (Join-Path $script:sourceRoot 'scripts') -Force | Out-Null
    $fakeEngine = @'
const args = process.argv.slice(2);
if (args.includes('--check-only')) {
  console.log(JSON.stringify({currentVersion: '0.3.0', newVersion: '0.4.0', port: 3000, target: args[args.indexOf('--target') + 1]}));
} else if (args.includes('--fail')) {
  console.error(JSON.stringify({event: 'error', code: 'PREPARATION_FAILED', message: 'private-untrusted-message'}));
  process.exitCode = 1;
} else {
  console.log('untrusted-secret-output');
  for (const code of ['preparing', 'installing', 'building', 'applying']) console.log(JSON.stringify({event: 'progress', code}));
  console.log(JSON.stringify({event: 'progress', code: 'unknown', message: 'untrusted-secret-output'}));
  process.stderr.write('private-stderr-output'.repeat(10000));
  console.log(JSON.stringify({event: 'complete', currentVersion: '0.3.0', newVersion: '0.4.0'}));
}
'@
    [IO.File]::WriteAllText((Join-Path $script:sourceRoot 'scripts/update.mjs'), $fakeEngine, (New-Object System.Text.UTF8Encoding($false)))
    $target = Join-Path $temporary ("Original O'Brien " + $unicodeFolder)
    $details = Invoke-UpdateEngine @('--target', $target, '--check-only') -checkOnly
    Assert-Equal $details.target $target 'The wizard changed the selected original installation path.'
    Assert-Equal $details.currentVersion '0.3.0' 'The wizard lost its engine check response.'
    Invoke-UpdateEngine @('--target', $target)
    Assert-Equal $script:messages.Count 4 'The wizard did not display only known progress events.'
    if (($script:messages -join ' ').Contains('secret')) { throw 'Raw engine output reached the GUI.' }
    $failed = $false
    try { Invoke-UpdateEngine @('--target', $target, '--fail') } catch { $failed = $true }
    if (-not $failed) { throw 'A failed update was reported as successful.' }
    if ($script:failureMessage.Contains('private-untrusted-message')) { throw 'Raw engine errors reached the GUI.' }
    if (-not $script:failureMessage.Contains('The installed app was not changed.')) { throw 'The known engine error was not mapped to an actionable message.' }
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
Write-Output 'Windows updater argument, progress, output redaction, and error handling checks passed.'
