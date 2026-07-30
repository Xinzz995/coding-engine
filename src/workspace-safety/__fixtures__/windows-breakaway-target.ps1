param(
  [Parameter(Mandatory = $true)] [string]$SourcePath,
  [Parameter(Mandatory = $true)] [string]$NodePath,
  [Parameter(Mandatory = $true)] [string]$EscapeMarker,
  [Parameter(Mandatory = $true)] [string]$OutcomePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'PowerShell FullLanguage mode is required for the breakaway fixture'
  }
  $sourceBytes = [System.IO.File]::ReadAllBytes($SourcePath)
  if ($sourceBytes.Length -gt 1MB) { throw 'breakaway fixture source is too large' }
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  Add-Type -TypeDefinition ($utf8.GetString($sourceBytes)) -Language CSharp -ReferencedAssemblies @(
    'System.dll',
    'System.Core.dll'
  ) -ErrorAction Stop
  exit [CodingX.WorkspaceSafety.Tests.WindowsBreakawayAttempt]::Run(
    $NodePath,
    $EscapeMarker,
    $OutcomePath
  )
} catch {
  [Console]::Error.WriteLine('coding-x Windows breakaway fixture failed')
  exit 2
}
