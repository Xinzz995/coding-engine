param(
  [Parameter(Mandatory = $true)]
  [string]$ExpectedHelperDigest,

  [Parameter(Mandatory = $true)]
  [string]$SourcePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CodingX.WorkspaceSafety
{
    public static class FixedAssetAttributes
    {
        public const uint InvalidFileAttributes = 0xffffffff;

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFileAttributesW(string fileName);

        public static uint Read(string path, out int error)
        {
            uint attributes = GetFileAttributesW(path);
            error = attributes == InvalidFileAttributes ? Marshal.GetLastWin32Error() : 0;
            return attributes;
        }
    }
}
'@ -Language CSharp -ErrorAction Stop

function Assert-FixedAsset {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedName
  )
  $fullPath = [System.IO.Path]::GetFullPath($Path)
  if (-not [string]::Equals(
    [System.IO.Path]::GetFileName($fullPath),
    $ExpectedName,
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Fixed helper asset name is invalid'
  }
  $nativeError = 0
  $attributes = [CodingX.WorkspaceSafety.FixedAssetAttributes]::Read(
    $fullPath,
    [ref]$nativeError
  )
  if ($attributes -eq [CodingX.WorkspaceSafety.FixedAssetAttributes]::InvalidFileAttributes) {
    throw "GetFileAttributesW failed for fixed helper asset with error $nativeError"
  }
  if (($attributes -band 0x400) -ne 0 -or ($attributes -band 0x10) -ne 0) {
    throw 'Fixed helper asset is not an ordinary non-reparse file'
  }
  return $fullPath
}

function Assert-ExactKeys {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][string[]]$Expected,
    [Parameter(Mandatory = $true)][string]$Label
  )
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $wanted = @($Expected | Sort-Object)
  if (($actual -join "`0") -cne ($wanted -join "`0")) {
    throw "$Label has unknown or missing fields"
  }
}

function Read-Attributes {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ResponsePath
  )
  $nativeError = 0
  $attributes = [CodingX.WorkspaceSafety.WindowsPathAttributes]::Read(
    $Path,
    [ref]$nativeError
  )
  if ($attributes -ne [CodingX.WorkspaceSafety.WindowsPathAttributes]::InvalidFileAttributes) {
    return @{
      path = $ResponsePath
      status = 'found'
      attributes = [uint32]$attributes
    }
  }
  if ($nativeError -eq 2 -or $nativeError -eq 3) {
    return @{ path = $ResponsePath; status = 'missing'; attributes = $null }
  }
  throw "GetFileAttributesW failed with error $nativeError"
}

function Read-BoundedInteger {
  param(
    [Parameter(Mandatory = $true)]$Value,
    [Parameter(Mandatory = $true)][int]$Minimum,
    [Parameter(Mandatory = $true)][int]$Maximum,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (
    $Value -isnot [byte] -and
    $Value -isnot [int16] -and
    $Value -isnot [int32] -and
    $Value -isnot [int64]
  ) {
    throw "$Label must be an integer"
  }
  $number = [int64]$Value
  if ($number -lt $Minimum -or $number -gt $Maximum) {
    throw "$Label is outside its supported boundary"
  }
  return [int]$number
}

function Assert-OrdinaryTreeRecord {
  param([Parameter(Mandatory = $true)]$Record)
  if ($Record.status -ne 'found') {
    throw 'Tree path disappeared during inspection'
  }
  if (($Record.attributes -band 0x400) -ne 0) {
    throw 'Tree contains a Windows reparse point'
  }
}

function Add-WorkspaceTreeEntries {
  param(
    [Parameter(Mandatory = $true)][string]$AbsolutePath,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][string]$FirstSegment,
    [Parameter(Mandatory = $true)][int]$Depth,
    [Parameter(Mandatory = $true)][int]$MaxDepth,
    [Parameter(Mandatory = $true)][int]$MaxBusinessEntries,
    [Parameter(Mandatory = $true)][int]$MaxSafetyEntries,
    [Parameter(Mandatory = $true)]$Budget
  )
  $record = Read-Attributes -Path $AbsolutePath -ResponsePath $RelativePath
  Assert-OrdinaryTreeRecord -Record $record
  $isSafety = [string]::Equals(
    $FirstSegment,
    'engine.lock',
    [System.StringComparison]::OrdinalIgnoreCase
  ) -or [string]::Equals(
    $RelativePath,
    'workspace-safety.json',
    [System.StringComparison]::OrdinalIgnoreCase
  )
  if ($isSafety) {
    $Budget.safety = [int]$Budget.safety + 1
    if ($Budget.safety -gt $MaxSafetyEntries) { throw 'Safety tree exceeds its entry boundary' }
  } else {
    $Budget.business = [int]$Budget.business + 1
    if ($Budget.business -gt $MaxBusinessEntries) { throw 'Business tree exceeds its entry boundary' }
  }
  $isDirectory = (($record.attributes -band 0x10) -ne 0)
  if (-not $isDirectory) { return }
  if ($Depth -gt $MaxDepth) { throw 'Tree exceeds the depth boundary' }
  foreach ($child in [CodingX.WorkspaceSafety.WindowsPathAttributes]::Entries($AbsolutePath)) {
    $name = [System.IO.Path]::GetFileName($child.TrimEnd('\'))
    if ([string]::IsNullOrEmpty($name) -or $name.Contains('/') -or $name.Contains('\')) {
      throw 'Tree returned an invalid child name'
    }
    $childRelative = "$RelativePath/$name"
    Add-WorkspaceTreeEntries `
      -AbsolutePath $child `
      -RelativePath $childRelative `
      -FirstSegment $FirstSegment `
      -Depth ($Depth + 1) `
      -MaxDepth $MaxDepth `
      -MaxBusinessEntries $MaxBusinessEntries `
      -MaxSafetyEntries $MaxSafetyEntries `
      -Budget $Budget
  }
}

function Add-SafetyTreeEntries {
  param(
    [Parameter(Mandatory = $true)][string]$AbsolutePath,
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][int]$Depth,
    [Parameter(Mandatory = $true)][int]$MaxDepth,
    [Parameter(Mandatory = $true)][int]$MaxSafetyEntries,
    [Parameter(Mandatory = $true)]$Budget,
    [ValidateSet('any', 'file', 'directory')][string]$ExpectedKind = 'any',
    [switch]$AllowMissing
  )
  $record = Read-Attributes -Path $AbsolutePath -ResponsePath $RelativePath
  if ($record.status -eq 'missing' -and $AllowMissing) { return }
  Assert-OrdinaryTreeRecord -Record $record
  $isDirectory = (($record.attributes -band 0x10) -ne 0)
  if (
    ($ExpectedKind -ceq 'file' -and $isDirectory) -or
    ($ExpectedKind -ceq 'directory' -and -not $isDirectory)
  ) {
    throw 'Safety root path has an invalid file type'
  }
  $Budget.safety = [int]$Budget.safety + 1
  if ($Budget.safety -gt $MaxSafetyEntries) { throw 'Safety tree exceeds its entry boundary' }
  if (-not $isDirectory) { return }
  if ($Depth -gt $MaxDepth) { throw 'Safety tree exceeds the depth boundary' }
  foreach ($child in [CodingX.WorkspaceSafety.WindowsPathAttributes]::Entries($AbsolutePath)) {
    $name = [System.IO.Path]::GetFileName($child.TrimEnd('\'))
    if ([string]::IsNullOrEmpty($name) -or $name.Contains('/') -or $name.Contains('\')) {
      throw 'Safety tree returned an invalid child name'
    }
    Add-SafetyTreeEntries `
      -AbsolutePath $child `
      -RelativePath "$RelativePath/$name" `
      -Depth ($Depth + 1) `
      -MaxDepth $MaxDepth `
      -MaxSafetyEntries $MaxSafetyEntries `
      -Budget $Budget
  }
}

function Read-TreeRoot {
  param([Parameter(Mandatory = $true)][string]$Root)
  $record = Read-Attributes -Path $Root -ResponsePath ''
  Assert-OrdinaryTreeRecord -Record $record
  if (($record.attributes -band 0x10) -eq 0) {
    throw 'Tree root is not a directory'
  }
  return $record
}

function Add-WorkspaceRootChildren {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][int]$MaxDepth,
    [Parameter(Mandatory = $true)][int]$MaxBusinessEntries,
    [Parameter(Mandatory = $true)][int]$MaxSafetyEntries,
    [Parameter(Mandatory = $true)]$Budget
  )
  foreach ($child in [CodingX.WorkspaceSafety.WindowsPathAttributes]::Entries($Root)) {
    $name = [System.IO.Path]::GetFileName($child.TrimEnd('\'))
    if ([string]::IsNullOrEmpty($name) -or $name.Contains('/') -or $name.Contains('\')) {
      throw 'Tree returned an invalid root child name'
    }
    if (
      ([string]::Equals($name, 'engine.lock', [System.StringComparison]::OrdinalIgnoreCase) -and
        $name -cne 'engine.lock') -or
      ([string]::Equals(
        $name,
        'workspace-safety.json',
        [System.StringComparison]::OrdinalIgnoreCase
      ) -and $name -cne 'workspace-safety.json')
    ) {
      throw 'Workspace safety root name does not use canonical spelling'
    }
    Add-WorkspaceTreeEntries `
      -AbsolutePath $child `
      -RelativePath $name `
      -FirstSegment $name `
      -Depth 1 `
      -MaxDepth $MaxDepth `
      -MaxBusinessEntries $MaxBusinessEntries `
      -MaxSafetyEntries $MaxSafetyEntries `
      -Budget $Budget
  }
}

function Read-SafetyTree {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][int]$MaxDepth,
    [Parameter(Mandatory = $true)][int]$MaxSafetyEntries,
    [Parameter(Mandatory = $true)]$Budget
  )
  Add-SafetyTreeEntries `
    -AbsolutePath ([System.IO.Path]::Combine($Root, 'workspace-safety.json')) `
    -RelativePath 'workspace-safety.json' `
    -Depth 1 `
    -MaxDepth $MaxDepth `
    -MaxSafetyEntries $MaxSafetyEntries `
    -Budget $Budget `
    -ExpectedKind 'file' `
    -AllowMissing
  Add-SafetyTreeEntries `
    -AbsolutePath ([System.IO.Path]::Combine($Root, 'engine.lock')) `
    -RelativePath 'engine.lock' `
    -Depth 1 `
    -MaxDepth $MaxDepth `
    -MaxSafetyEntries $MaxSafetyEntries `
    -Budget $Budget `
    -ExpectedKind 'directory' `
    -AllowMissing
}

function Assert-CanonicalSafetyRootNames {
  param([Parameter(Mandatory = $true)][string]$Root)
  foreach ($expected in @('workspace-safety.json', 'engine.lock')) {
    $matches = @(
      [CodingX.WorkspaceSafety.WindowsPathAttributes]::Entries($Root, $expected)
    )
    if ($matches.Count -gt 1) {
      throw 'Workspace contains duplicate Windows-equivalent safety root names'
    }
    if ($matches.Count -eq 1) {
      $actual = [System.IO.Path]::GetFileName($matches[0].TrimEnd('\'))
      if ($actual -cne $expected) {
        throw 'Workspace safety root name does not use canonical spelling'
      }
    }
  }
}

function Assert-TreePayload {
  param([Parameter(Mandatory = $true)]$Payload, [switch]$Workspace)
  $expected = if ($Workspace) {
    @('root', 'maxBusinessEntries', 'maxSafetyEntries', 'maxDepth')
  } else {
    @('root', 'maxSafetyEntries', 'maxDepth')
  }
  Assert-ExactKeys -Value $Payload -Expected $expected -Label 'tree payload'
  if ($Payload.root -isnot [string] -or -not [System.IO.Path]::IsPathRooted($Payload.root)) {
    throw 'Tree root must be an absolute string'
  }
}

function New-TreeResponse {
  param(
    [Parameter(Mandatory = $true)][string]$Mode,
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][uint32]$RootAttributes,
    [Parameter(Mandatory = $true)]$Budget
  )
  $response = @{
    schemaVersion = 1
    mode = $Mode
    root = $Root
    rootAttributes = $RootAttributes
    safetyEntries = [int]$Budget.safety
    complete = $true
  }
  if ($Mode -ceq 'workspace-tree-v1') {
    $response.businessEntries = [int]$Budget.business
  }
  return $response
}

function Assert-PathsPayload {
  param([Parameter(Mandatory = $true)]$Payload)
  Assert-ExactKeys -Value $Payload -Expected @('paths') -Label 'paths payload'
  $paths = @($Payload.paths)
  if ($paths.Count -eq 0 -or $paths.Count -gt 4096) {
    throw 'Path count exceeds its boundary'
  }
  return $paths
}

function Read-PathsResponse {
  param([Parameter(Mandatory = $true)]$Payload)
  $records = New-Object System.Collections.ArrayList
  foreach ($path in (Assert-PathsPayload -Payload $Payload)) {
    if ($path -isnot [string] -or -not [System.IO.Path]::IsPathRooted($path)) {
      throw 'Path must be an absolute string'
    }
    [void]$records.Add((Read-Attributes -Path $path -ResponsePath $path))
  }
  return @{
    schemaVersion = 1
    mode = 'paths-v1'
    records = @($records)
  }
}

function Read-TreeResponse {
  param([Parameter(Mandatory = $true)]$Request)
  $workspaceMode = $Request.mode -ceq 'workspace-tree-v1'
  Assert-TreePayload -Payload $Request.payload -Workspace:$workspaceMode
  $maxSafetyEntries = Read-BoundedInteger `
    -Value $Request.payload.maxSafetyEntries -Minimum 0 -Maximum 100000 -Label 'maxSafetyEntries'
  $maxDepth = Read-BoundedInteger `
    -Value $Request.payload.maxDepth -Minimum 0 -Maximum 256 -Label 'maxDepth'
  $maxBusinessEntries = if ($workspaceMode) {
    Read-BoundedInteger `
      -Value $Request.payload.maxBusinessEntries `
      -Minimum 0 `
      -Maximum 100000 `
      -Label 'maxBusinessEntries'
  } else { 0 }
  $rootRecord = Read-TreeRoot -Root $Request.payload.root
  Assert-CanonicalSafetyRootNames -Root $Request.payload.root
  $budget = @{ business = 0; safety = 0 }
  if ($workspaceMode) {
    Add-WorkspaceRootChildren `
      -Root $Request.payload.root `
      -MaxDepth $maxDepth `
      -MaxBusinessEntries $maxBusinessEntries `
      -MaxSafetyEntries $maxSafetyEntries `
      -Budget $budget
  } else {
    Read-SafetyTree `
      -Root $Request.payload.root `
      -MaxDepth $maxDepth `
      -MaxSafetyEntries $maxSafetyEntries `
      -Budget $budget
  }
  return New-TreeResponse `
    -Mode $Request.mode `
    -Root $Request.payload.root `
    -RootAttributes ([uint32]$rootRecord.attributes) `
    -Budget $budget
}

try {
  if ($ExpectedHelperDigest -notmatch '^sha256:[0-9a-f]{64}$') {
    throw 'Invalid helper digest'
  }
  $scriptPath = Assert-FixedAsset `
    -Path $MyInvocation.MyCommand.Path `
    -ExpectedName 'windows-path-attributes.ps1'
  $fixedSourcePath = Assert-FixedAsset `
    -Path $SourcePath `
    -ExpectedName 'WindowsPathAttributes.cs'
  if (-not [string]::Equals(
    [System.IO.Path]::GetDirectoryName($scriptPath),
    [System.IO.Path]::GetDirectoryName($fixedSourcePath),
    [System.StringComparison]::OrdinalIgnoreCase
  )) {
    throw 'Fixed helper assets do not belong to one bundle root'
  }
  $scriptBytes = [System.IO.File]::ReadAllBytes($scriptPath)
  $sourceBytes = [System.IO.File]::ReadAllBytes($fixedSourcePath)
  if ($scriptBytes.Length -gt 1MB -or $sourceBytes.Length -gt 1MB) {
    throw 'Helper exceeds its size boundary'
  }
  $bundle = New-Object System.IO.MemoryStream
  $domain = $utf8.GetBytes("coding-x-windows-path-attributes-v1`0")
  $sourceDomain = $utf8.GetBytes("`0WindowsPathAttributes.cs`0")
  $bundle.Write($domain, 0, $domain.Length)
  $bundle.Write($scriptBytes, 0, $scriptBytes.Length)
  $bundle.Write($sourceDomain, 0, $sourceDomain.Length)
  $bundle.Write($sourceBytes, 0, $sourceBytes.Length)
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  try {
    $actualDigest = 'sha256:' + ([System.BitConverter]::ToString(
      $sha256.ComputeHash($bundle.ToArray())
    ).Replace('-', '').ToLowerInvariant())
  } finally {
    $sha256.Dispose()
    $bundle.Dispose()
  }
  if ($actualDigest -cne $ExpectedHelperDigest) {
    throw 'Fixed helper digest mismatch'
  }
  Add-Type -TypeDefinition ($utf8.GetString($sourceBytes)) -Language CSharp -ErrorAction Stop

  $requestText = [Console]::In.ReadToEnd()
  if ($requestText.Length -eq 0 -or $requestText.Length -gt 1MB) {
    throw 'Request exceeds its size boundary'
  }
  $request = $requestText | ConvertFrom-Json
  Assert-ExactKeys -Value $request -Expected @('schemaVersion', 'mode', 'payload') -Label 'request'
  if ((Read-BoundedInteger `
    -Value $request.schemaVersion -Minimum 1 -Maximum 1 -Label 'schemaVersion') -ne 1) {
    throw 'Unsupported request schema'
  }

  $responseValue = if ($request.mode -ceq 'paths-v1') {
    Read-PathsResponse -Payload $request.payload
  } elseif (
    $request.mode -ceq 'safety-tree-v1' -or
    $request.mode -ceq 'workspace-tree-v1'
  ) {
    Read-TreeResponse -Request $request
  } else {
    throw 'Unsupported request mode'
  }

  $response = $responseValue | ConvertTo-Json -Depth 4 -Compress
  if ($utf8.GetByteCount($response) -gt 4MB) {
    throw 'Response exceeds its size boundary'
  }
  [Console]::Out.Write($response)
  exit 0
} catch {
  [Console]::Error.WriteLine('coding-x Windows path attribute inspection failed')
  exit 2
}
