param(
  [Parameter(Mandatory = $true)] [string]$SourcePath,
  [Parameter(Mandatory = $true)] [string]$NodePath,
  [Parameter(Mandatory = $true)] [string]$WorkerPath,
  [Parameter(Mandatory = $true)] [string]$AssetRoot,
  [Parameter(Mandatory = $true)] [string]$Workspace,
  [Parameter(Mandatory = $true)] [string]$ReadyPath,
  [Parameter(Mandatory = $true)] [string]$ContinuePath,
  [Parameter(Mandatory = $true)] [string]$OutcomePath,
  [Parameter(Mandatory = $true)] [ValidateSet('compatible', 'incompatible')] [string]$Mode
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'PowerShell FullLanguage mode is required for the outer-Job driver'
  }
  $sourceBytes = [System.IO.File]::ReadAllBytes($SourcePath)
  if ($sourceBytes.Length -gt 1MB) { throw 'outer-Job driver source is too large' }
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  Add-Type -TypeDefinition ($utf8.GetString($sourceBytes)) -Language CSharp -ReferencedAssemblies @(
    'System.dll',
    'System.Core.dll'
  ) -ErrorAction Stop
  exit [CodingX.WorkspaceSafety.Tests.WindowsCtrlCDriver]::RunOuterJob(
    $NodePath,
    $WorkerPath,
    $AssetRoot,
    $Workspace,
    $ReadyPath,
    $ContinuePath,
    $OutcomePath,
    $Mode
  )
} catch {
  [Console]::Error.WriteLine('coding-x Windows outer-Job driver failed')
  exit 2
}
