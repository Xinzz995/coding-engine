param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$ProcessSourcePath,

  [Parameter(Mandatory = $true)]
  [string]$AuthoritySourcePath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedHelperDigest,

  [Parameter(Mandatory = $true)]
  [string]$TimeoutsBase64
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

function Write-DiagnosticStage {
  param([Parameter(Mandatory = $true)][string]$Name)
  [Console]::Error.WriteLine(
    'coding-x-supervisor-stage:{0}:{1}' -f $Name, [DateTime]::UtcNow.ToString('o')
  )
  [Console]::Error.Flush()
}

try {
  Write-DiagnosticStage 'powershell-entered'
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'PowerShell FullLanguage mode is required'
  }
  if ($ExpectedHelperDigest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Invalid helper digest'
  }

  $scriptPath = $MyInvocation.MyCommand.Path
  $scriptBytes = [System.IO.File]::ReadAllBytes($scriptPath)
  $sourceNames = @(
    'WindowsJobSupervisor.cs',
    'WindowsJobProcess.cs',
    'WindowsJobAuthority.cs'
  )
  $sourcePaths = @($SourcePath, $ProcessSourcePath, $AuthoritySourcePath)
  $sourceParts = New-Object System.Collections.ArrayList
  foreach ($path in $sourcePaths) {
    [void]$sourceParts.Add([System.IO.File]::ReadAllBytes($path))
  }
  if ($scriptBytes.Length -gt 4MB) {
    throw 'Helper asset exceeds its size limit'
  }
  foreach ($part in $sourceParts) {
    if ($part.Length -gt 4MB) {
      throw 'Helper asset exceeds its size limit'
    }
  }

  $bundle = New-Object System.IO.MemoryStream
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  $powershellDomain = $utf8.GetBytes("coding-x-windows-supervisor-powershell-v1`0")
  $bundle.Write($powershellDomain, 0, $powershellDomain.Length)
  $bundle.Write($scriptBytes, 0, $scriptBytes.Length)
  for ($index = 0; $index -lt $sourceParts.Count; $index++) {
    $csharpDomain = $utf8.GetBytes(
      "`0coding-x-windows-supervisor-csharp-v1:$($sourceNames[$index])`0"
    )
    $bundle.Write($csharpDomain, 0, $csharpDomain.Length)
    $bundle.Write($sourceParts[$index], 0, $sourceParts[$index].Length)
  }
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $actualHelperDigest = 'sha256:' + ([System.BitConverter]::ToString(
      $sha256.ComputeHash($bundle.ToArray())
    ).Replace('-', '').ToLowerInvariant())
  } finally {
    $sha256.Dispose()
    $bundle.Dispose()
  }
  if ($actualHelperDigest -cne $ExpectedHelperDigest) {
    throw 'Fixed helper digest mismatch'
  }
  Write-DiagnosticStage 'digest-verified'

  # Compile the exact source bytes that participated in the digest. Add-Type never receives a
  # project path or project-provided source text.
  $sourceTexts = New-Object System.Collections.ArrayList
  foreach ($part in $sourceParts) {
    [void]$sourceTexts.Add($utf8.GetString($part))
  }
  $sourceText = $sourceTexts -join "`r`n"
  Write-DiagnosticStage 'add-type-started'
  Add-Type -TypeDefinition $sourceText -Language CSharp -ReferencedAssemblies @(
    'System.dll',
    'System.Core.dll',
    'System.Web.Extensions.dll'
  ) -ErrorAction Stop
  Write-DiagnosticStage 'add-type-completed'

  exit [CodingX.WorkspaceSafety.WindowsJobSupervisor]::Run(
    $ExpectedHelperDigest,
    $TimeoutsBase64
  )
} catch {
  [Console]::Error.WriteLine('coding-x Windows Job supervisor initialization failed')
  exit 2
}
