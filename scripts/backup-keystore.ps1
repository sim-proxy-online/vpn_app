# Зашифрованный бэкап ключа подписи APK.
#
# ПОЧЕМУ ЭТО КРИТИЧНО: android/release.keystore подписывает все релизы.
# Android запрещает обновление поверх приложения с другим сертификатом —
# потеря keystore = все установленные приложения нельзя обновить, только
# удалить и переустановить (потеря профилей у пользователей).
#
# Использование:
#   .\scripts\backup-keystore.ps1 -Passphrase '...'            # создать бэкап
#   .\scripts\backup-keystore.ps1 -Passphrase '...' -Restore -OutDir .\restored  # восстановить
#
# Формат контейнера (всё little-endian):
#   magic "SKB1" (4) | salt (16) | iv (16) | hmac-sha256 (32) | ciphertext
# Ключ: PBKDF2-SHA256, 200000 итераций, 64 байта → 32 (AES) + 32 (HMAC).
# Шифрование: AES-256-CBC, encrypt-then-MAC. Платформа защищена HMAC'ом
# (подделка шифртекста отклоняется до расшифровки).
param(
  [Parameter(Mandatory = $true)][string]$Passphrase,
  [switch]$Restore,
  [string]$OutDir,
  [string]$InFile
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

# Файлы, без которых нельзя выпустить новую версию APK.
$Sources = @(
  (Join-Path $RepoRoot 'android\release.keystore'),
  (Join-Path $RepoRoot 'android\keystore.properties')
)

function Get-AesKeys([string]$pass, [byte[]]$salt) {
  $kdf = [System.Security.Cryptography.Rfc2898DeriveBytes]::new($pass, $salt, 200000, [System.Security.Cryptography.HashAlgorithmName]::SHA256)
  $mat = $kdf.GetBytes(64)
  return @{ Aes = $mat[0..31]; Mac = $mat[32..63] }
}

if (-not $Restore) {
  foreach ($f in $Sources) { if (-not (Test-Path $f)) { throw "Не найден: $f" } }

  # Плейнхедер: [4 байта длина имени][имя UTF8][8 байт длина][содержимое] × N
  $ms = [System.IO.MemoryStream]::new()
  foreach ($f in $Sources) {
    $name = [System.Text.Encoding]::UTF8.GetBytes((Split-Path -Leaf $f))
    $bytes = [System.IO.File]::ReadAllBytes($f)
    $ms.Write([BitConverter]::GetBytes($name.Length), 0, 4)
    $ms.Write($name, 0, $name.Length)
    $len = [BitConverter]::GetBytes([int64]$bytes.Length)
    $ms.Write($len, 0, 8)
    $ms.Write($bytes, 0, $bytes.Length)
  }
  $plain = $ms.ToArray(); $ms.Dispose()

  $salt = [byte[]]::new(16); $iv = [byte[]]::new(16)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($salt); $rng.GetBytes($iv)
  $keys = Get-AesKeys $Passphrase $salt

  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'; $aes.KeySize = 256
  $aes.Key = $keys.Aes; $aes.IV = $iv
  $ct = $aes.CreateEncryptor().TransformFinalBlock($plain, 0, $plain.Length)
  $aes.Dispose()

  # Encrypt-then-MAC: подпись охватывает magic+salt+iv+ct → платформа защищена целиком.
  $hmac = [System.Security.Cryptography.HMACSHA256]::new($keys.Mac)
  $magic = [System.Text.Encoding]::ASCII.GetBytes('SKB1')
  $macInput = [byte[]]::new($magic.Length + $salt.Length + $iv.Length + $ct.Length)
  [Array]::Copy($magic, 0, $macInput, 0, $magic.Length)
  [Array]::Copy($salt, 0, $macInput, $magic.Length, $salt.Length)
  [Array]::Copy($iv, 0, $macInput, $magic.Length + $salt.Length, $iv.Length)
  [Array]::Copy($ct, 0, $macInput, $magic.Length + $salt.Length + $iv.Length, $ct.Length)
  $mac = $hmac.ComputeHash($macInput)

  $out = [byte[]]::new($magic.Length + 16 + 16 + 32 + $ct.Length)
  [Array]::Copy($magic, 0, $out, 0, 4)
  [Array]::Copy($salt, 0, $out, 4, 16)
  [Array]::Copy($iv, 0, $out, 20, 16)
  [Array]::Copy($mac, 0, $out, 36, 32)
  [Array]::Copy($ct, 0, $out, 68, $ct.Length)

  $stamp = Get-Date -Format 'yyyyMMdd'
  $dests = if ($OutDir) { @($OutDir) } else {
    @((Join-Path (Split-Path -Parent $RepoRoot) 'keystore-backup'),
      (Join-Path $env:USERPROFILE 'Documents\SimProxy-keystore-backup'))
  }
  foreach ($d in $dests) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
    $path = Join-Path $d "keystore-$stamp.enc"
    [System.IO.File]::WriteAllBytes($path, $out)
    Write-Output "СОХРАНЕНО: $path"
  }
  Write-Output "Исходных файлов: $($Sources.Count); размер контейнера: $($out.Length) байт"
  exit 0
}

# --- Восстановление ---
if (-not $InFile) { throw 'Укажите -InFile <keystore-YYYYMMDD.enc>' }
$raw = [System.IO.File]::ReadAllBytes($InFile)
if ($raw.Length -lt 69 -or [System.Text.Encoding]::ASCII.GetString($raw[0..3]) -ne 'SKB1') {
  throw 'Не формат SKB1 или файл повреждён'
}
$salt = $raw[4..19]; $iv = $raw[20..35]; $macStored = $raw[36..67]; $ct = $raw[68..($raw.Length - 1)]
$keys = Get-AesKeys $Passphrase $salt

$hmac = [System.Security.Cryptography.HMACSHA256]::new($keys.Mac)
# Подпись охватывает magic(4)+salt(16)+iv(16)+ct: байты 0..35, затем сам ct (с 68-го).
$macInput = [byte[]]::new(36 + $ct.Length)
[Array]::Copy($raw, 0, $macInput, 0, 36)
[Array]::Copy($ct, 0, $macInput, 36, $ct.Length)
$mac = $hmac.ComputeHash($macInput)
$equal = $true
for ($i = 0; $i -lt 32; $i++) { if ($mac[$i] -ne $macStored[$i]) { $equal = $false } }
if (-not $equal) { throw 'HMAC не сошёлся: неверная фраза-пароль или файл подделан/повреждён' }

$aes = [System.Security.Cryptography.Aes]::Create()
$aes.Mode = 'CBC'; $aes.Padding = 'PKCS7'; $aes.KeySize = 256
$aes.Key = $keys.Aes; $aes.IV = $iv
$plain = $aes.CreateDecryptor().TransformFinalBlock($ct, 0, $ct.Length)
$aes.Dispose()

$dest = if ($OutDir) { $OutDir } else { Join-Path $RepoRoot 'android' }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$pos = 0
while ($pos -lt $plain.Length) {
  $nameLen = [BitConverter]::ToInt32($plain, $pos); $pos += 4
  $name = [System.Text.Encoding]::UTF8.GetString($plain, $pos, $nameLen); $pos += $nameLen
  $len = [BitConverter]::ToInt64($plain, $pos); $pos += 8
  $bytes = $plain[$pos..($pos + $len - 1)]; $pos += $len
  $target = Join-Path $dest $name
  if ((Test-Path $target) -and -not $OutDir) { throw "$target уже существует — восстановите в пустую папку (-OutDir)" }
  [System.IO.File]::WriteAllBytes($target, $bytes)
  Write-Output "ВОССТАНОВЛЕНО: $target"
}
