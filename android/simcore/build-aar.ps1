# Сборка libs/simcore.aar (Go-обёртка над xray-core) через gomobile bind.
# Требуется: Go (>=1.26), gomobile и gobind в PATH, JDK 17+, Android SDK и NDK.
#   .\build-aar.ps1 -Sdk D:\android-tools\sdk -Ndk D:\android-tools\sdk\ndk\27.2.12479018
param(
    [string]$Sdk = $env:ANDROID_HOME,
    [string]$Ndk = $env:ANDROID_NDK_HOME
)
$ErrorActionPreference = 'Stop'
if (-not $Sdk -or -not $Ndk) { throw 'Укажите -Sdk и -Ndk (или ANDROID_HOME / ANDROID_NDK_HOME)' }
$env:ANDROID_HOME = $Sdk; $env:ANDROID_SDK_ROOT = $Sdk; $env:ANDROID_NDK_HOME = $Ndk

Set-Location $PSScriptRoot
$out = Join-Path $PSScriptRoot '..\app\libs'
New-Item -ItemType Directory -Force $out | Out-Null

# max-page-size=16384 — выравнивание страниц 16 КБ (требование Google Play для 64-бит).
$ld = '-ldflags=-s -w -extldflags=-Wl,-z,max-page-size=16384'
& gomobile bind -v '-target=android/arm64,android/arm' -androidapi 24 -javapkg com.simproxy -trimpath $ld `
    -o (Join-Path $out 'simcore.aar') .
if ($LASTEXITCODE -ne 0) { throw "gomobile bind завершился с кодом $LASTEXITCODE" }
