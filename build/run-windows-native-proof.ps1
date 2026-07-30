[CmdletBinding()]
param(
    [switch]$Child,
    [string]$Request
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($Child) {
    if ([string]::IsNullOrWhiteSpace($Request)) {
        throw 'Child proof requires -Request'
    }
    $requestData = Get-Content -LiteralPath $Request -Raw | ConvertFrom-Json
    $env:TEMP = $requestData.tempPath
    $env:TMP = $requestData.tempPath
    Set-Location -LiteralPath $requestData.workspace
    $childNodePath = [string]$requestData.nodePath
    & $childNodePath build/windows-native-proof.mjs `
        --expected-user $requestData.userName `
        --result $requestData.resultPath
    exit $LASTEXITCODE
}

if ($env:GITHUB_ACTIONS -ne 'true' -or $env:ImageOS -ne 'win22') {
    throw "This proof must run on the required GitHub Windows Server 2022 image (ImageOS=win22)"
}

$currentIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
$currentPrincipal = [Security.Principal.WindowsPrincipal]::new($currentIdentity)
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'The setup process needs administrator rights only to create the disposable standard user'
}

$workspace = (Resolve-Path -LiteralPath $env:GITHUB_WORKSPACE).Path
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$suffix = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$userName = "cxp$suffix"
$proofRoot = Join-Path $env:SystemDrive "cxp-$suffix"
$proofScript = Join-Path $proofRoot 'proof.ps1'
$requestPath = Join-Path $proofRoot 'request.json'
$resultPath = Join-Path $proofRoot 'result.json'
$stdoutPath = Join-Path $proofRoot 'stdout.log'
$stderrPath = Join-Path $proofRoot 'stderr.log'
$testTemp = Join-Path $proofRoot 'temp'
$createdUser = $false

try {
    New-Item -ItemType Directory -Path $proofRoot | Out-Null
    New-Item -ItemType Directory -Path $testTemp | Out-Null
    Copy-Item -LiteralPath $PSCommandPath -Destination $proofScript

    $plainPassword = "Cx!$([Guid]::NewGuid().ToString('N'))aA1"
    $securePassword = ConvertTo-SecureString $plainPassword -AsPlainText -Force
    $user = New-LocalUser `
        -Name $userName `
        -Password $securePassword `
        -AccountNeverExpires `
        -PasswordNeverExpires `
        -UserMayNotChangePassword
    $createdUser = $true

    $account = "$env:COMPUTERNAME\$userName"
    & icacls.exe $proofRoot /grant "${account}:(OI)(CI)M" /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not grant the proof user access to $proofRoot"
    }
    & icacls.exe $workspace /grant "${account}:(OI)(CI)M" /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Could not grant the proof user access to $workspace"
    }

    @{
        nodePath = $nodePath
        resultPath = $resultPath
        tempPath = $testTemp
        userName = $userName
        workspace = $workspace
    } | ConvertTo-Json | Set-Content -LiteralPath $requestPath -Encoding utf8NoBOM

    $credential = [PSCredential]::new($account, $securePassword)
    $childArguments = @(
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        $proofScript,
        '-Child',
        '-Request',
        $requestPath
    )
    $childProcess = Start-Process `
        -FilePath (Get-Process -Id $PID).Path `
        -ArgumentList $childArguments `
        -Credential $credential `
        -LoadUserProfile `
        -WorkingDirectory $workspace `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -Wait `
        -PassThru

    $childStdout = if (Test-Path -LiteralPath $stdoutPath) {
        Get-Content -LiteralPath $stdoutPath -Raw
    } else { '' }
    $childStderr = if (Test-Path -LiteralPath $stderrPath) {
        Get-Content -LiteralPath $stderrPath -Raw
    } else { '' }
    if ($childProcess.ExitCode -ne 0) {
        throw "Standard-user proof exited $($childProcess.ExitCode)`nstdout:`n$childStdout`nstderr:`n$childStderr"
    }
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        throw 'Standard-user proof returned success without a result file'
    }
    $proof = Get-Content -LiteralPath $resultPath -Raw | ConvertFrom-Json
    if ($proof.status -ne 'passed' -or $proof.actualUser -ne $userName) {
        throw 'Standard-user proof result did not bind the disposable account'
    }
    Write-Output $childStdout.Trim()
}
finally {
    if ($createdUser) {
        Remove-LocalUser -Name $userName -ErrorAction SilentlyContinue
    }
    Remove-Item -LiteralPath $proofRoot -Recurse -Force -ErrorAction SilentlyContinue
}
