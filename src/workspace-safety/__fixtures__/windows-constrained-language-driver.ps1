param(
  [Parameter(Mandatory = $true)] [string]$SupervisorPath,
  [Parameter(Mandatory = $true)] [string]$SourcePath,
  [Parameter(Mandatory = $true)] [string]$ProcessSourcePath,
  [Parameter(Mandatory = $true)] [string]$AuthoritySourcePath,
  [Parameter(Mandatory = $true)] [string]$ExpectedHelperDigest,
  [Parameter(Mandatory = $true)] [string]$TimeoutsBase64
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
& $SupervisorPath `
  -SourcePath $SourcePath `
  -ProcessSourcePath $ProcessSourcePath `
  -AuthoritySourcePath $AuthoritySourcePath `
  -ExpectedHelperDigest $ExpectedHelperDigest `
  -TimeoutsBase64 $TimeoutsBase64
exit $LASTEXITCODE
