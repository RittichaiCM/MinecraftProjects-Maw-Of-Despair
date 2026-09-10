param(
  [string]$OutputDirectory = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repoRoot = Split-Path -Parent $PSScriptRoot
$behaviorPack = Join-Path $repoRoot "behavior_pack\Maw_Of_Despair_BP"
$resourcePack = Join-Path $repoRoot "resource_pack\Maw_Of_Despair_RP"

if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repoRoot "dist"
} elseif (-not [System.IO.Path]::IsPathRooted($OutputDirectory)) {
  $OutputDirectory = Join-Path $repoRoot $OutputDirectory
}

function Get-PackVersion([string]$manifestPath) {
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  return ($manifest.header.version -join ".")
}

function Copy-PackForRelease([string]$source, [string]$destination) {
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  $sourcePrefix = $source.TrimEnd("\") + "\"

  Get-ChildItem -LiteralPath $source -Recurse -File | Where-Object {
    $_.Name -notin @("DEVELOPMENT_TEST.md", ".DS_Store", "Thumbs.db", "desktop.ini") -and
    $_.Name -notlike "* - Copy.*" -and
    $_.Extension -notin @(".bak", ".backup", ".bbmodel")
  } | ForEach-Object {
    $relativePath = $_.FullName.Substring($sourcePrefix.Length)
    $targetPath = Join-Path $destination $relativePath
    $targetDirectory = Split-Path -Parent $targetPath
    New-Item -ItemType Directory -Force -Path $targetDirectory | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $targetPath
  }
}

function New-ZipFromDirectory([string]$source, [string]$destination) {
  if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Force
  }

  [System.IO.Compression.ZipFile]::CreateFromDirectory(
    $source,
    $destination,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false
  )
}

$packageVersion = (Get-Content -Raw -LiteralPath (Join-Path $repoRoot "package.json") | ConvertFrom-Json).version
$behaviorVersion = Get-PackVersion (Join-Path $behaviorPack "manifest.json")
$resourceVersion = Get-PackVersion (Join-Path $resourcePack "manifest.json")

if ($packageVersion -ne $behaviorVersion -or $packageVersion -ne $resourceVersion) {
  throw "Version mismatch: package.json=$packageVersion, BP=$behaviorVersion, RP=$resourceVersion"
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("maw-of-despair-build-" + [guid]::NewGuid())
$stagedBehaviorPack = Join-Path $temporaryRoot "Maw_Of_Despair_BP"
$stagedResourcePack = Join-Path $temporaryRoot "Maw_Of_Despair_RP"
$addonStage = Join-Path $temporaryRoot "addon"

try {
  Copy-PackForRelease $behaviorPack $stagedBehaviorPack
  Copy-PackForRelease $resourcePack $stagedResourcePack
  New-Item -ItemType Directory -Force -Path $addonStage | Out-Null
  New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

  $behaviorMcpack = Join-Path $addonStage "Maw_Of_Despair_BP.mcpack"
  $resourceMcpack = Join-Path $addonStage "Maw_Of_Despair_RP.mcpack"
  New-ZipFromDirectory $stagedBehaviorPack $behaviorMcpack
  New-ZipFromDirectory $stagedResourcePack $resourceMcpack

  $addonPath = Join-Path $OutputDirectory "Maw-of-Despair-v$packageVersion.mcaddon"
  New-ZipFromDirectory $addonStage $addonPath

  $archive = [System.IO.Compression.ZipFile]::OpenRead($addonPath)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    if ($entries -notcontains "Maw_Of_Despair_BP.mcpack" -or $entries -notcontains "Maw_Of_Despair_RP.mcpack") {
      throw "The MCAddon archive is missing a behavior or resource pack."
    }
  } finally {
    $archive.Dispose()
  }

  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $addonPath).Hash
  Write-Output "Built: $addonPath"
  Write-Output "Version: $packageVersion"
  Write-Output "SHA256: $hash"
} finally {
  if (Test-Path -LiteralPath $temporaryRoot) {
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
  }
}
