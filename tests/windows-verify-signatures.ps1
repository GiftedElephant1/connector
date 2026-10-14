# Exercise release-gate logic with mocked signature results, never real signing.
# These fixtures do not establish that a package or certificate is trusted.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent $PSScriptRoot
$verifier = Join-Path $repository 'scripts/windows-verify-signatures.ps1'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('connector-signature-fixtures-' + [Guid]::NewGuid().ToString('N'))
$package = Join-Path $temporary 'package'
$report = Join-Path $temporary 'fixture-report.json'
$signatureContext = @{ Scenario = 'valid-mock' }

function Assert-SignatureFixture([bool]$condition, [string]$message) {
    if (-not $condition) { throw $message }
}

function New-FixtureCertificate([string]$subject, [string]$issuer, [string]$usage = '1.3.6.1.5.5.7.3.3') {
    $extensions = [Security.Cryptography.X509Certificates.X509ExtensionCollection]::new()
    if ($usage) {
        $usages = [Security.Cryptography.OidCollection]::new()
        [void]$usages.Add([Security.Cryptography.Oid]::new($usage))
        # Use the actual extension type returned by X509Certificate2.Extensions.
        $extension = [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usages, $false)
        [void]$extensions.Add($extension)
    }
    return [PSCustomObject]@{
        Subject = $subject
        Issuer = $issuer
        Thumbprint = ('0' * 40)
        Extensions = $extensions
    }
}

# The production script resolves this local mock instead of the Windows cmdlet.
# No test adds certificates to a store or generates an actual signed file.
# Windows PowerShell 5.1 closures run in a dynamic module that cannot resolve
# this script's helper functions. Capture the factory itself, not just its name.
$fixtureCertificateFactory = ${function:New-FixtureCertificate}
${function:Get-AuthenticodeSignature} = {
    param([string]$LiteralPath)
    $subject = 'CN=Fixture Publisher, O=Not A Real Code Signing Certificate'
    $issuer = 'CN=Fixture CA, O=Not Trusted'
    $usage = '1.3.6.1.5.5.7.3.3'
    $status = 'Valid'
    $timestamp = [PSCustomObject]@{ Subject = 'CN=Mock Timestamp, O=Not Trusted' }
    switch ($signatureContext.Scenario) {
        'unsigned' { $status = 'NotSigned' }
        'tampered' { $status = 'HashMismatch' }
        'self-signed' { $issuer = $subject }
        'wrong-eku' { $usage = '1.3.6.1.5.5.7.3.1' }
        'no-eku' { $usage = '' }
        'no-timestamp' { $timestamp = $null }
        'mixed-publisher' {
            if ([IO.Path]::GetFileName($LiteralPath) -eq 'windows-common.ps1') { $subject = 'CN=Another Fixture Publisher' }
        }
    }
    return [PSCustomObject]@{
        Status = $status
        SignerCertificate = (& $fixtureCertificateFactory $subject $issuer $usage)
        TimeStamperCertificate = $timestamp
    }
}.GetNewClosure()

function Assert-FixtureRejected([string]$scenario, [string]$messagePattern) {
    $signatureContext.Scenario = $scenario
    if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report }
    $rejected = $false
    try { & $verifier -Path $package -ReportPath $report | Out-Null }
    catch {
        if ($_.Exception.Message -notmatch $messagePattern) {
            throw "Fixture $scenario failed for an unexpected reason: $($_.Exception.Message)"
        }
        $rejected = $true
    }
    Assert-SignatureFixture $rejected "Fixture $scenario was incorrectly accepted."
    Assert-SignatureFixture (-not (Test-Path -LiteralPath $report)) "Fixture $scenario produced a success report."
}

try {
    New-Item -ItemType Directory -Path (Join-Path $package 'scripts') -Force | Out-Null
    $launcher = @'
command = "powershell.exe -ExecutionPolicy AllSigned -WindowStyle Normal -HideLaunchConsole"
result = shell.Run(command, 1, False)
'@
    foreach ($name in @('Start Connector.vbs', 'Update Connector.vbs')) {
        [IO.File]::WriteAllText((Join-Path $package $name), $launcher)
    }
    foreach ($name in @('windows-launcher.ps1', 'windows-update.ps1', 'windows-common.ps1', 'windows-background.ps1')) {
        [IO.File]::WriteAllText((Join-Path $package ('scripts/' + $name)), '# Unsigned inert signature-verifier fixture.')
    }

    $certificate = New-FixtureCertificate 'Fixture' 'Fixture issuer'
    $extension = @($certificate.Extensions)[0]
    Assert-SignatureFixture ($extension -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) 'The EKU fixture did not use a real .NET extension type.'
    Assert-SignatureFixture ($extension.EnhancedKeyUsages[0].Value -eq '1.3.6.1.5.5.7.3.3') 'The EKU fixture lost its code-signing OID.'

    & $verifier -Path $package -ReportPath $report | Out-Null
    $result = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
    Assert-SignatureFixture ($result.files.Count -eq 6) 'The verifier did not check all six fixture scripts.'
    Assert-SignatureFixture ($result.publisher -match 'Not A Real Code Signing Certificate') 'Fixture report did not identify its mock publisher.'
    foreach ($record in $result.files) {
        $expected = (Get-FileHash -LiteralPath (Join-Path $package $record.file) -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-SignatureFixture ($record.sha256 -eq $expected) 'A fixture report hash did not match its actual file.'
    }

    Assert-FixtureRejected 'unsigned' 'Invalid or missing publisher signature'
    Assert-FixtureRejected 'tampered' 'Invalid or missing publisher signature'
    Assert-FixtureRejected 'self-signed' 'Self-signed publishers are not accepted'
    Assert-FixtureRejected 'wrong-eku' 'A code-signing certificate is required'
    Assert-FixtureRejected 'no-eku' 'A code-signing certificate is required'
    Assert-FixtureRejected 'no-timestamp' 'A trusted signing timestamp is required'
    Assert-FixtureRejected 'mixed-publisher' 'Release scripts must share one verified publisher'

    [IO.File]::WriteAllText((Join-Path $package 'Start Connector.vbs'), $launcher.Replace('AllSigned', 'Bypass'))
    Assert-FixtureRejected 'valid-mock' 'Release launcher must show publisher approval and enforce AllSigned'
    [IO.File]::WriteAllText((Join-Path $package 'Start Connector.vbs'), $launcher.Replace('WindowStyle Normal', 'WindowStyle Hidden'))
    Assert-FixtureRejected 'valid-mock' 'Release launcher must show publisher approval and enforce AllSigned'
    [IO.File]::WriteAllText((Join-Path $package 'Start Connector.vbs'), $launcher)
    Remove-Item -LiteralPath (Join-Path $package 'scripts/windows-common.ps1')
    Assert-FixtureRejected 'valid-mock' 'Required release script missing'
    Write-Output 'Signature release-gate fixtures passed. These mocked results do not verify real publisher signatures.'
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
}
