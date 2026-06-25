<#
.SYNOPSIS
  Сборка подписанной Windows-версии SimProxy.

.DESCRIPTION
  Подставляет сертификат подписи кода в переменные окружения и запускает сборку
  (vite build + electron-builder). Поддерживает два типа сертификата:

  1) Обычный .pfx (OV-сертификат):
       ./desktop/build-signed.ps1 -PfxPath C:\certs\sim.pfx -PfxPassword "пароль"

  2) EV-сертификат на USB-токене:
       - в desktop/electron-builder.yml раскомментируйте certificateSubjectName
         и впишите точное "issued to" из сертификата;
       - подключите токен и запустите без параметров:
       ./desktop/build-signed.ps1 -UseToken

  Без подписи (как раньше):
       node node_modules\vite\bin\vite.js build
       node node_modules\electron-builder\out\cli\cli.js --config desktop/electron-builder.yml
#>
[CmdletBinding(DefaultParameterSetName = 'Pfx')]
param(
  [Parameter(ParameterSetName = 'Pfx', Mandatory = $true)]
  [string]$PfxPath,

  [Parameter(ParameterSetName = 'Pfx', Mandatory = $true)]
  [string]$PfxPassword,

  [Parameter(ParameterSetName = 'Token', Mandatory = $true)]
  [switch]$UseToken
)

$ErrorActionPreference = 'Stop'
# Запускаемся из корня репозитория (на уровень выше desktop/).
Set-Location (Join-Path $PSScriptRoot '..')

if ($PSCmdlet.ParameterSetName -eq 'Pfx') {
  if (-not (Test-Path $PfxPath)) { throw "Файл сертификата не найден: $PfxPath" }
  $env:CSC_LINK = (Resolve-Path $PfxPath).Path
  $env:CSC_KEY_PASSWORD = $PfxPassword
  Write-Host "Подпись: .pfx -> $($env:CSC_LINK)" -ForegroundColor Cyan
}
else {
  # EV-токен: ключи не передаём, подпись идёт через certificateSubjectName в yml.
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  Write-Host "Подпись: EV-токен (certificateSubjectName из electron-builder.yml)" -ForegroundColor Cyan
}

Write-Host "1/2 Сборка веб-части (vite build)..." -ForegroundColor Yellow
node node_modules\vite\bin\vite.js build

Write-Host "2/2 Упаковка и подпись (electron-builder)..." -ForegroundColor Yellow
node node_modules\electron-builder\out\cli\cli.js --config desktop/electron-builder.yml

Write-Host "Готово. Проверьте подпись:" -ForegroundColor Green
Write-Host '  Get-AuthenticodeSignature .\desktop\dist-exe\SimProxy-2.0.0-portable.exe | Format-List'
