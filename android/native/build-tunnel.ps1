# Сборка libhev-socks5-tunnel.so (открытый hev-socks5-tunnel, MIT) под имя Java-класса
# com.simproxy.core.Tunnel. Результат кладётся в android/app/src/main/jniLibs/<abi>/.
#
# Требуется: Android NDK (ANDROID_NDK_HOME или -Ndk), git.
#   .\build-tunnel.ps1 -Ndk D:\android-tools\sdk\ndk\27.2.12479018
param(
    [string]$Ndk = $env:ANDROID_NDK_HOME,
    [string]$Tag = '2.18.0'
)
$ErrorActionPreference = 'Stop'
if (-not $Ndk -or -not (Test-Path "$Ndk\ndk-build.cmd")) { throw 'Укажите путь к NDK: -Ndk <папка NDK>' }

$here = $PSScriptRoot
$src  = Join-Path $here 'hev-socks5-tunnel'
$out  = Join-Path $here '..\app\src\main\jniLibs' | Resolve-Path -ErrorAction SilentlyContinue
if (-not $out) { New-Item -ItemType Directory -Force (Join-Path $here '..\app\src\main\jniLibs') | Out-Null; $out = Resolve-Path (Join-Path $here '..\app\src\main\jniLibs') }

if (-not (Test-Path $src)) {
    git clone --depth 1 --branch $Tag --recursive --shallow-submodules https://github.com/heiher/hev-socks5-tunnel.git $src
}

# В репозитории hev есть символические ссылки; Windows при клонировании превращает их в
# текстовые файлы с путём. Заменяем такие файлы копиями реальных целей.
Push-Location $src
$links = @(git ls-files -s | Where-Object { $_ -match '^120000' } | ForEach-Object { ($_ -split "`t", 2)[1] })
foreach ($sub in 'src/core', 'third-part/hev-task-system', 'third-part/lwip', 'third-part/yaml') {
    Push-Location $sub
    $links += git ls-files -s | Where-Object { $_ -match '^120000' } | ForEach-Object { "$sub/" + (($_ -split "`t", 2)[1]) }
    Pop-Location
}
foreach ($l in ($links | Sort-Object -Unique)) {
    $p = Join-Path (Get-Location) $l
    if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { continue }
    $target = (Get-Content -LiteralPath $p -Raw).Trim()
    $abs = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $p) $target))
    if (Test-Path -LiteralPath $abs -PathType Leaf) { Copy-Item -LiteralPath $abs -Destination $p -Force }
    elseif (Test-Path -LiteralPath $abs -PathType Container) { Remove-Item -LiteralPath $p -Force; Copy-Item -LiteralPath $abs -Destination $p -Recurse }
}

$obj = Join-Path $env:TEMP 'simproxy-hev-obj'
New-Item -ItemType Directory -Force $obj | Out-Null
& "$Ndk\ndk-build.cmd" NDK_PROJECT_PATH=. APP_BUILD_SCRIPT=Android.mk `
    APP_ABI="arm64-v8a armeabi-v7a" APP_PLATFORM=android-24 APP_MODULES=hev-socks5-tunnel `
    "NDK_OUT=$obj" "NDK_LIBS_OUT=$out" "APP_CFLAGS=-DPKGNAME=com/simproxy/core -DCLSNAME=Tunnel" -j8
if ($LASTEXITCODE -ne 0) { throw "ndk-build завершился с кодом $LASTEXITCODE" }
Pop-Location
Write-Host "Готово: $out"
