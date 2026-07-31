[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string]$SourcePath,
    [Parameter(Mandatory = $true)] [string]$OutputAssembly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    throw 'PowerShell FullLanguage mode is required to compile the Windows test fixture'
}

$resolvedSource = (Resolve-Path -LiteralPath $SourcePath).Path
$sourceBytes = [System.IO.File]::ReadAllBytes($resolvedSource)
if ($sourceBytes.Length -gt 1MB) {
    throw 'Windows test fixture source is too large'
}
if (Test-Path -LiteralPath $OutputAssembly) {
    throw "Windows test fixture output already exists: $OutputAssembly"
}

$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
Add-Type `
    -TypeDefinition ($utf8.GetString($sourceBytes)) `
    -Language CSharp `
    -ReferencedAssemblies @('System.dll', 'System.Core.dll') `
    -OutputAssembly $OutputAssembly `
    -OutputType Library `
    -ErrorAction Stop

if (-not (Test-Path -LiteralPath $OutputAssembly -PathType Leaf)) {
    throw 'Windows test fixture compiler returned without an assembly'
}
