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
  $script:DiagnosticStage = $Name
  $message = 'coding-x-supervisor-stage:' + $Name + ':' + [DateTime]::UtcNow.ToString('o')
  [Console]::Error.WriteLine($message)
  [Console]::Error.Flush()
}

$DiagnosticStage = 'script-parsed'
try {
  Write-DiagnosticStage 'powershell-entered'
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'PowerShell FullLanguage mode is required'
  }
  if ($ExpectedHelperDigest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Invalid helper digest'
  }
  Write-DiagnosticStage 'preconditions-verified'

  $scriptPath = $MyInvocation.MyCommand.Path
  $scriptBytes = [System.IO.File]::ReadAllBytes($scriptPath)
  Write-DiagnosticStage 'script-read'
  $sourceNames = @(
    'WindowsJobSupervisor.cs',
    'WindowsJobProcess.cs',
    'WindowsJobAuthority.cs'
  )
  $sourcePaths = @($SourcePath, $ProcessSourcePath, $AuthoritySourcePath)
  $sourceParts = @($null, $null, $null)
  for ($index = 0; $index -lt $sourcePaths.Count; $index++) {
    Write-DiagnosticStage ('source-' + $index + '-read-started')
    $path = $sourcePaths[$index]
    $sourceParts[$index] = [System.IO.File]::ReadAllBytes($path)
    Write-DiagnosticStage ('source-' + $index + '-read-completed')
  }
  Write-DiagnosticStage 'sources-read'
  if ($scriptBytes.Length -gt 4MB) {
    throw 'Helper asset exceeds its size limit'
  }
  foreach ($part in $sourceParts) {
    if ($part.Length -gt 4MB) {
      throw 'Helper asset exceeds its size limit'
    }
  }
  Write-DiagnosticStage 'sizes-verified'

  $bundle = [System.IO.MemoryStream]::new()
  $utf8 = [System.Text.UTF8Encoding]::new($false, $true)
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
  Write-DiagnosticStage 'bundle-built'
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $actualHelperDigest = 'sha256:' + ([System.BitConverter]::ToString(
      $sha256.ComputeHash($bundle.ToArray())
    ).Replace('-', '').ToLowerInvariant())
  } finally {
    $sha256.Dispose()
      $bundle.Dispose()
  }
  Write-DiagnosticStage 'digest-computed'
  if ($actualHelperDigest -cne $ExpectedHelperDigest) {
    throw 'Fixed helper digest mismatch'
  }
  Write-DiagnosticStage 'digest-verified'

  # Compile the exact source bytes that participated in the digest. Add-Type never receives a
  # project path or project-provided source text.
  $sourceTexts = @($null, $null, $null)
  for ($index = 0; $index -lt $sourceParts.Count; $index++) {
    $sourceTexts[$index] = $utf8.GetString($sourceParts[$index])
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
  $message = 'coding-x Windows Job supervisor initialization failed at ' +
    $DiagnosticStage + ': ' + $_.Exception.GetType().FullName + ': ' + $_.Exception.Message
  [Console]::Error.WriteLine($message)
  exit 2
}
