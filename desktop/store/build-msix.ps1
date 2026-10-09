# Builds the Microsoft Store (MSIX) package of Kvadrat Petrovicha from an already packed app directory.
#
#   1) npx electron-builder --win dir --x64 --config desktop/electron-builder.yml --publish never
#      (produces desktop/dist-exe/win-unpacked; the npm script "desktop:msix" runs both steps)
#   2) powershell -File desktop/store/build-msix.ps1 [-Store -IdentityName .. -Publisher .. -PublisherDisplayName ..]
#
# Without -Store a local TEST package with a placeholder identity is produced (cannot be submitted).
# With -Store the three identity values from Partner Center are mandatory (or STORE_IDENTITY_NAME,
# STORE_PUBLISHER, STORE_PUBLISHER_DISPLAY_NAME environment variables). The package is NOT signed:
# the Store signs it itself after certification.
# NOTE: keep this file ASCII-only (Windows PowerShell 5.1 reads BOM-less files as ANSI).
param(
  [string]$Unpacked = '',
  [string]$Out = '',
  [switch]$Store,
  [string]$IdentityName = $env:STORE_IDENTITY_NAME,
  [string]$Publisher = $env:STORE_PUBLISHER,
  [string]$PublisherDisplayName = $env:STORE_PUBLISHER_DISPLAY_NAME
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $Unpacked) { $Unpacked = Join-Path $root 'desktop\dist-exe\win-unpacked' }
if (-not (Test-Path (Join-Path $Unpacked 'KvadratPetrovicha.exe'))) { throw "KvadratPetrovicha.exe not found in $Unpacked - run electron-builder --win dir first" }

$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$parts = ($pkg.version -replace '[-+].*$', '').Split('.')
while ($parts.Count -lt 3) { $parts += '0' }
$version = ($parts[0..2] -join '.') + '.0'   # the Store requires the 4th part to be 0

if ($Store) {
  if (-not $IdentityName -or -not $Publisher -or -not $PublisherDisplayName) {
    throw '-Store needs -IdentityName, -Publisher and -PublisherDisplayName exactly as shown in Partner Center (Product identity).'
  }
} else {
  if (-not $IdentityName) { $IdentityName = 'KvadratPetrovicha.LocalTest' }
  if (-not $Publisher) { $Publisher = 'CN=KvadratPetrovichaLocalTest' }
  if (-not $PublisherDisplayName) { $PublisherDisplayName = 'Kvadrat Petrovicha (local test)' }
}
if (-not $Out) {
  $suffix = if ($Store) { 'store' } else { 'store-test' }
  $Out = Join-Path $root "desktop\dist-exe\KvadratPetrovicha-$($pkg.version)-$suffix.msix"
}

# ── makeappx: Windows SDK or the copy that electron-builder keeps in its cache ──
$tool = @(
  Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending
  Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\winCodeSign\*\windows-10\x64\makeappx.exe" -ErrorAction SilentlyContinue
) | Select-Object -First 1
if (-not $tool) { throw 'makeappx.exe not found (install the Windows SDK or run an electron-builder Windows build once)' }
$makeappx = $tool.FullName
# The tool set from the electron-builder cache fails with "side-by-side configuration is incorrect" when
# its folder path contains spaces (e.g. C:\Users\First Last\...): run a copy from a path without spaces.
if ($makeappx -match '\s') {
  $copy = Join-Path $root 'desktop\dist-exe\_makeappx'
  if ($copy -match '\s') { throw "Cannot run makeappx from a path with spaces: $copy" }
  $null = robocopy (Split-Path $makeappx) $copy /MIR /NFL /NDL /NJH /NJS /NP
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }
  $global:LASTEXITCODE = 0
  $makeappx = Join-Path $copy 'makeappx.exe'
}

# ── staging directory = app files + manifest + logos ──
$stage = Join-Path $root 'desktop\dist-exe\msix-staging'
$null = robocopy $Unpacked $stage /MIR /XF elevate.exe /NFL /NDL /NJH /NJS /NP
if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }
$global:LASTEXITCODE = 0

Add-Type -AssemblyName System.Drawing
$assets = Join-Path $stage 'Assets'
New-Item -ItemType Directory -Force -Path $assets | Out-Null
$src = [System.Drawing.Image]::FromFile((Join-Path $root 'icon.png'))
# icon.png is the shield on a transparent background that already has its own margin: scale it whole.
foreach ($l in @(@('StoreLogo', 50), @('Square44x44Logo', 44), @('Square150x150Logo', 150))) {
  $bmp = New-Object System.Drawing.Bitmap $l[1], $l[1]
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.SmoothingMode = 'HighQuality'; $g.PixelOffsetMode = 'HighQuality'
  $g.DrawImage($src, 0, 0, $l[1], $l[1]); $g.Dispose()
  $bmp.Save((Join-Path $assets "$($l[0]).png"), [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
}
$src.Dispose()

$xml = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'AppxManifest.template.xml'), [System.Text.Encoding]::UTF8)
foreach ($kv in @{ IDENTITY_NAME = $IdentityName; PUBLISHER = $Publisher; PUBLISHER_DISPLAY_NAME = $PublisherDisplayName; VERSION = $version }.GetEnumerator()) {
  $xml = $xml.Replace('{{' + $kv.Key + '}}', [System.Security.SecurityElement]::Escape($kv.Value))
}
[System.IO.File]::WriteAllText((Join-Path $stage 'AppxManifest.xml'), $xml, (New-Object System.Text.UTF8Encoding($false)))

# ── pack (semantic validation of the manifest stays ON) ──
& $makeappx pack /d $stage /p $Out /o
if ($LASTEXITCODE -ne 0) { throw "makeappx failed with exit code $LASTEXITCODE" }
$f = Get-Item $Out
'{0}  {1:N1} MB  version {2}  identity {3}' -f $f.FullName, ($f.Length / 1MB), $version, $IdentityName
'sha256 ' + (Get-FileHash $Out -Algorithm SHA256).Hash.ToLower()
