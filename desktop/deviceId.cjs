// Идентификатор устройства для сервера пробного периода (src/trial.ts).
// Хеш MachineGuid Windows: переживает переустановку приложения, сам GUID наружу не уходит.
// Форма — UUID, как у HWID на Android (NativeBridge.getHwid). Прочитать не удалось → null,
// и пробный доступ не выдаётся.
const crypto = require('crypto');
const { execFile } = require('child_process');

let cached;

function hashToUuid(guid) {
  const h = crypto.createHash('sha256').update('simproxy:' + String(guid).toLowerCase()).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function getDeviceId() {
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve((cached = null));
    execFile('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
      { windowsHide: true, timeout: 5000 }, (err, stdout) => {
        const m = !err && /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{36})/.exec(String(stdout));
        if (!m) return resolve(null); // не кэшируем сбой — следующая попытка может пройти
        resolve((cached = hashToUuid(m[1])));
      });
  });
}

module.exports = { getDeviceId, hashToUuid };
