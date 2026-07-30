[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Generate', 'Verify')]
  [string]$Mode,

  [string]$OutputDirectory,

  [string]$CommittedExecutable,

  [string]$SourceCommit
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$ExpectedSdkVersion = '10.0.302'
$ExecutableName = 'coding-x-windows-supervisor.exe'
$ExecutableDigestDomain = "coding-x-windows-supervisor-exe-v1`0"
$MaximumExecutableBytes = 4MB
$InvocationDirectory = [System.IO.Directory]::GetCurrentDirectory()
$ProjectDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot)
$RepositoryRoot = [System.IO.Path]::GetFullPath(
  [System.IO.Path]::Combine($ProjectDirectory, '..', '..')
)
$ProjectPath = [System.IO.Path]::Combine(
  $ProjectDirectory,
  'CodingX.WindowsSupervisor.csproj'
)
$NugetConfigPath = [System.IO.Path]::Combine($ProjectDirectory, 'nuget.config')

function Assert-ModeArguments {
  if ($Mode -eq 'Generate') {
    if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
      throw 'Generate mode requires -OutputDirectory'
    }
    if (-not [string]::IsNullOrWhiteSpace($CommittedExecutable)) {
      throw 'Generate mode does not accept -CommittedExecutable'
    }
    return
  }
  if ([string]::IsNullOrWhiteSpace($CommittedExecutable)) {
    throw 'Verify mode requires -CommittedExecutable'
  }
  if (-not [string]::IsNullOrWhiteSpace($OutputDirectory)) {
    throw 'Verify mode does not accept -OutputDirectory'
  }
}

function Invoke-Dotnet {
  param([Parameter(Mandatory = $true)][string[]]$Arguments)
  & $script:DotnetCommand @Arguments | Out-Host
  if ($LASTEXITCODE -ne 0) {
    throw "dotnet command failed with exit code $LASTEXITCODE"
  }
}

function Get-FileBytes {
  param([Parameter(Mandatory = $true)][string]$Path)
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -le 0 -or $bytes.Length -gt $MaximumExecutableBytes) {
    throw "Executable is outside its size limit: $Path"
  }
  if ($bytes.Length -lt 2 -or $bytes[0] -ne 0x4d -or $bytes[1] -ne 0x5a) {
    throw "Build output is not a Windows PE executable: $Path"
  }
  return ,$bytes
}

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][byte[]]$Bytes)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([System.BitConverter]::ToString($sha256.ComputeHash($Bytes))).Replace(
      '-',
      ''
    ).ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-FileSha256Hex {
  param([Parameter(Mandatory = $true)][string]$Path)
  return (Get-Sha256Hex -Bytes ([System.IO.File]::ReadAllBytes($Path)))
}

function Resolve-InvocationPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath(
    [System.IO.Path]::Combine($InvocationDirectory, $Path)
  )
}

function Get-HelperDigest {
  param([Parameter(Mandatory = $true)][byte[]]$ExecutableBytes)
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
  $domain = $utf8.GetBytes($ExecutableDigestDomain)
  $inputBytes = [byte[]]::new($domain.Length + $ExecutableBytes.Length)
  [System.Buffer]::BlockCopy($domain, 0, $inputBytes, 0, $domain.Length)
  [System.Buffer]::BlockCopy(
    $ExecutableBytes,
    0,
    $inputBytes,
    $domain.Length,
    $ExecutableBytes.Length
  )
  return 'sha256:' + (Get-Sha256Hex -Bytes $inputBytes)
}

function Assert-SameBytes {
  param(
    [Parameter(Mandatory = $true)][byte[]]$Expected,
    [Parameter(Mandatory = $true)][byte[]]$Actual,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if ($Expected.Length -ne $Actual.Length) {
    throw "$Label byte length differs"
  }
  for ($index = 0; $index -lt $Expected.Length; $index++) {
    if ($Expected[$index] -ne $Actual[$index]) {
      throw "$Label differs at byte offset $index"
    }
  }
}

function Invoke-DeterministicBuild {
  param([Parameter(Mandatory = $true)][string]$SlotRoot)
  $sourceDirectory = [System.IO.Path]::Combine($SlotRoot, 'source')
  $isolatedProjectDirectory = [System.IO.Path]::Combine(
    $sourceDirectory,
    'native',
    'windows-supervisor'
  )
  $isolatedAssetDirectory = [System.IO.Path]::Combine(
    $sourceDirectory,
    'assets',
    'workspace-safety'
  )
  [System.IO.Directory]::CreateDirectory($isolatedProjectDirectory) | Out-Null
  [System.IO.Directory]::CreateDirectory($isolatedAssetDirectory) | Out-Null
  foreach ($name in @(
      'CodingX.WindowsSupervisor.csproj',
      'global.json',
      'nuget.config',
      'packages.lock.json'
    )) {
    [System.IO.File]::Copy(
      [System.IO.Path]::Combine($ProjectDirectory, $name),
      [System.IO.Path]::Combine($isolatedProjectDirectory, $name),
      $false
    )
  }
  foreach ($name in @(
      'WindowsSupervisorProgram.cs',
      'WindowsJobSupervisor.cs',
      'WindowsJobProcess.cs',
      'WindowsJobAuthority.cs'
    )) {
    [System.IO.File]::Copy(
      [System.IO.Path]::Combine($RepositoryRoot, 'assets', 'workspace-safety', $name),
      [System.IO.Path]::Combine($isolatedAssetDirectory, $name),
      $false
    )
  }
  $isolatedProjectPath = [System.IO.Path]::Combine(
    $isolatedProjectDirectory,
    'CodingX.WindowsSupervisor.csproj'
  )
  $isolatedNugetConfigPath = [System.IO.Path]::Combine(
    $isolatedProjectDirectory,
    'nuget.config'
  )
  $objectDirectory = [System.IO.Path]::Combine($SlotRoot, 'obj')
  $outputDirectory = [System.IO.Path]::Combine($SlotRoot, 'out')
  [System.IO.Directory]::CreateDirectory($objectDirectory) | Out-Null
  [System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
  $objectDirectoryProperty = $objectDirectory + [System.IO.Path]::DirectorySeparatorChar
  $outputDirectoryProperty = $outputDirectory + [System.IO.Path]::DirectorySeparatorChar
  $sharedProperties = @(
    "-p:BaseIntermediateOutputPath=$objectDirectoryProperty",
    "-p:MSBuildProjectExtensionsPath=$objectDirectoryProperty",
    "-p:CodingXSourceRoot=$sourceDirectory",
    "-p:CodingXBuildRoot=$SlotRoot",
    '-p:RestoreLockedMode=true',
    '-p:Deterministic=true',
    '-p:ContinuousIntegrationBuild=true',
    '-p:UseSharedCompilation=false'
  )

  Invoke-Dotnet -Arguments (@(
      'restore',
      $isolatedProjectPath,
      '--locked-mode',
      '--nologo',
      '--verbosity',
      'minimal',
      '--configfile',
      $isolatedNugetConfigPath
    ) + $sharedProperties)

  Invoke-Dotnet -Arguments (@(
      'build',
      $isolatedProjectPath,
      '--configuration',
      'Release',
      '--no-restore',
      '--nologo',
      '--verbosity',
      'minimal',
      '--disable-build-servers',
      "-p:OutputPath=$outputDirectoryProperty"
    ) + $sharedProperties)

  $executable = [System.IO.Path]::Combine($outputDirectory, $ExecutableName)
  if (-not [System.IO.File]::Exists($executable)) {
    throw "Build did not produce $ExecutableName"
  }
  return $executable
}

function Resolve-SourceCommit {
  $observedOutput = @(& git -C $RepositoryRoot rev-parse HEAD)
  if ($LASTEXITCODE -ne 0 -or $observedOutput.Count -ne 1) {
    throw 'Could not resolve the source commit'
  }
  $observed = $observedOutput[0].Trim().ToLowerInvariant()
  if ($observed -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$') {
    throw 'Source commit must be a full hexadecimal object id'
  }
  if (-not [string]::IsNullOrWhiteSpace($SourceCommit)) {
    $declared = $SourceCommit.ToLowerInvariant()
    if ($declared -notmatch '^(?:[0-9a-f]{40}|[0-9a-f]{64})$' -or
        $declared -cne $observed) {
      throw 'Declared source commit does not match the checked-out HEAD'
    }
  }
  return $observed
}

Assert-ModeArguments
$dotnet = Get-Command dotnet -CommandType Application -ErrorAction Stop
$DotnetCommand = $dotnet.Source
$buildRoot = [System.IO.Path]::Combine(
  [System.IO.Path]::GetTempPath(),
  'coding-x-windows-supervisor-build-' + [System.Guid]::NewGuid().ToString('N')
)
[System.IO.Directory]::CreateDirectory($buildRoot) | Out-Null

$previousTelemetry = $env:DOTNET_CLI_TELEMETRY_OPTOUT
$previousFirstTime = $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE
$previousLanguage = $env:DOTNET_CLI_UI_LANGUAGE
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
$env:DOTNET_CLI_UI_LANGUAGE = 'en-US'

try {
  Push-Location $ProjectDirectory
  try {
    $sdkVersion = (& $DotnetCommand --version).Trim()
    if ($LASTEXITCODE -ne 0 -or $sdkVersion -cne $ExpectedSdkVersion) {
      throw "Expected .NET SDK $ExpectedSdkVersion but received '$sdkVersion'"
    }

    $firstExecutable = Invoke-DeterministicBuild -SlotRoot (
      [System.IO.Path]::Combine($buildRoot, 'first')
    )
    $secondExecutable = Invoke-DeterministicBuild -SlotRoot (
      [System.IO.Path]::Combine($buildRoot, 'second')
    )
    $firstBytes = Get-FileBytes -Path $firstExecutable
    $secondBytes = Get-FileBytes -Path $secondExecutable
    Assert-SameBytes -Expected $firstBytes -Actual $secondBytes `
      -Label 'Independent supervisor builds'

    $rawDigest = Get-Sha256Hex -Bytes $firstBytes
    $helperDigest = Get-HelperDigest -ExecutableBytes $firstBytes
    $sourceCommitValue = Resolve-SourceCommit

    if ($Mode -eq 'Verify') {
      $committedPath = Resolve-InvocationPath -Path $CommittedExecutable
      if (-not [System.IO.File]::Exists($committedPath)) {
        throw "Committed executable does not exist: $committedPath"
      }
      Assert-SameBytes -Expected $firstBytes -Actual (Get-FileBytes -Path $committedPath) `
        -Label 'Committed supervisor executable'
      [ordered]@{
        mode = 'Verify'
        sourceCommit = $sourceCommitValue
        executable = $ExecutableName
        rawSha256 = $rawDigest
        helperDigest = $helperDigest
      } | ConvertTo-Json -Compress
      return
    }

    $outputPath = Resolve-InvocationPath -Path $OutputDirectory
    [System.IO.Directory]::CreateDirectory($outputPath) | Out-Null
    $destination = [System.IO.Path]::Combine($outputPath, $ExecutableName)
    [System.IO.File]::WriteAllBytes($destination, $firstBytes)

    $inputPaths = @(
      [ordered]@{ name = 'native/windows-supervisor/CodingX.WindowsSupervisor.csproj'; path = $ProjectPath },
      [ordered]@{ name = 'native/windows-supervisor/build.ps1'; path = $PSCommandPath },
      [ordered]@{ name = 'native/windows-supervisor/global.json'; path = [System.IO.Path]::Combine($ProjectDirectory, 'global.json') },
      [ordered]@{ name = 'native/windows-supervisor/nuget.config'; path = $NugetConfigPath },
      [ordered]@{ name = 'native/windows-supervisor/packages.lock.json'; path = [System.IO.Path]::Combine($ProjectDirectory, 'packages.lock.json') },
      [ordered]@{ name = 'assets/workspace-safety/WindowsSupervisorProgram.cs'; path = [System.IO.Path]::Combine($RepositoryRoot, 'assets', 'workspace-safety', 'WindowsSupervisorProgram.cs') },
      [ordered]@{ name = 'assets/workspace-safety/WindowsJobSupervisor.cs'; path = [System.IO.Path]::Combine($RepositoryRoot, 'assets', 'workspace-safety', 'WindowsJobSupervisor.cs') },
      [ordered]@{ name = 'assets/workspace-safety/WindowsJobProcess.cs'; path = [System.IO.Path]::Combine($RepositoryRoot, 'assets', 'workspace-safety', 'WindowsJobProcess.cs') },
      [ordered]@{ name = 'assets/workspace-safety/WindowsJobAuthority.cs'; path = [System.IO.Path]::Combine($RepositoryRoot, 'assets', 'workspace-safety', 'WindowsJobAuthority.cs') }
    )
    $inputs = @($inputPaths | ForEach-Object {
      [ordered]@{
        path = $_.name
        sha256 = (Get-FileSha256Hex -Path $_.path)
      }
    })
    $manifest = [ordered]@{
      schemaVersion = 1
      sourceCommit = $sourceCommitValue
      sdkVersion = $sdkVersion
      targetFramework = 'net46'
      platformTarget = 'AnyCPU'
      executable = $ExecutableName
      executableBytes = $firstBytes.Length
      rawSha256 = $rawDigest
      helperDigest = $helperDigest
      inputs = $inputs
    }
    $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
    [System.IO.File]::WriteAllText(
      [System.IO.Path]::Combine($outputPath, 'SHA256SUMS'),
      "$rawDigest  $ExecutableName`n",
      $utf8
    )
    [System.IO.File]::WriteAllText(
      [System.IO.Path]::Combine($outputPath, 'build-manifest.json'),
      ($manifest | ConvertTo-Json -Depth 5) + "`n",
      $utf8
    )
    $manifest | ConvertTo-Json -Compress -Depth 5
  } finally {
    Pop-Location
  }
} finally {
  $env:DOTNET_CLI_TELEMETRY_OPTOUT = $previousTelemetry
  $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = $previousFirstTime
  $env:DOTNET_CLI_UI_LANGUAGE = $previousLanguage
  if ([System.IO.Directory]::Exists($buildRoot)) {
    Remove-Item -LiteralPath $buildRoot -Recurse -Force
  }
}
