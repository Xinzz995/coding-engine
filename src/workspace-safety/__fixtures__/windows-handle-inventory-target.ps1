param(
  [Parameter(Mandatory = $true)] [ValidateSet('root', 'descendant')] [string]$Mode,
  [Parameter(Mandatory = $true)] [string]$SourcePath,
  [Parameter(Mandatory = $true)] [string]$PowerShellPath,
  [Parameter(Mandatory = $true)] [string]$ScriptPath,
  [Parameter(Mandatory = $true)] [string]$RootInventoryPath,
  [Parameter(Mandatory = $true)] [string]$DescendantInventoryPath,
  [Parameter(Mandatory = $true)] [string]$ReadyPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

try {
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'PowerShell FullLanguage mode is required for the handle inventory fixture'
  }
  $sourceBytes = [System.IO.File]::ReadAllBytes($SourcePath)
  if ($sourceBytes.Length -gt 1MB) { throw 'handle inventory fixture source is too large' }
  $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
  Add-Type -TypeDefinition ($utf8.GetString($sourceBytes)) -Language CSharp -ReferencedAssemblies @(
    'System.dll',
    'System.Core.dll'
  ) -ErrorAction Stop
  if ($Mode -eq 'descendant') {
    exit [CodingX.WorkspaceSafety.Tests.WindowsHandleInventory]::RunDescendant(
      $DescendantInventoryPath
    )
  }
  exit [CodingX.WorkspaceSafety.Tests.WindowsHandleInventory]::RunRoot(
    $PowerShellPath,
    $ScriptPath,
    $SourcePath,
    $RootInventoryPath,
    $DescendantInventoryPath,
    $ReadyPath
  )
} catch {
  [Console]::Error.WriteLine('coding-x Windows handle inventory fixture failed')
  exit 2
}
