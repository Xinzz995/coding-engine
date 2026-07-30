param(
  [Parameter(Mandatory = $true)]
  [string]$SourcePath,

  [Parameter(Mandatory = $true)]
  [string]$NodePath,

  [Parameter(Mandatory = $true)]
  [string]$WorkerPath,

  [Parameter(Mandatory = $true)]
  [string]$AssetRoot,

  [Parameter(Mandatory = $true)]
  [string]$Workspace,

  [Parameter(Mandatory = $true)]
  [string]$ReadyPath,

  [Parameter(Mandatory = $true)]
  [string]$OutcomePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'PowerShell FullLanguage mode is required for the Ctrl+C driver'
  }
  $sourceBytes = [System.IO.File]::ReadAllBytes($SourcePath)
  if ($sourceBytes.Length -gt 1MB) {
    throw 'Ctrl+C driver source is too large'
  }
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  Add-Type -TypeDefinition ($utf8.GetString($sourceBytes)) -Language CSharp -ReferencedAssemblies @(
    'System.dll',
    'System.Core.dll'
  ) -ErrorAction Stop
  exit [CodingX.WorkspaceSafety.Tests.WindowsCtrlCDriver]::Run(
    $NodePath,
    $WorkerPath,
    $AssetRoot,
    $Workspace,
    $ReadyPath,
    $OutcomePath
  )
} catch {
  [Console]::Error.WriteLine('coding-x Windows Ctrl+C driver failed')
  exit 2
}
