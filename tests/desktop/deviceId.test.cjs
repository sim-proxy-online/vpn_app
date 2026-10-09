// ID устройства для сервера пробного периода (desktop/deviceId.cjs): на Windows читается реальный
// MachineGuid, наружу уходит только его хеш в форме UUID; повторные вызовы дают то же значение.
const assert = require('assert');
const path = require('path');
const { getDeviceId, hashToUuid } = require(path.join(__dirname, '..', '..', 'desktop', 'deviceId.cjs'));

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
let failed = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

(async () => {
  await t('hash is deterministic, UUID-shaped, case-insensitive and does not contain the GUID', () => {
    const g = '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0';
    const a = hashToUuid(g);
    assert.match(a, UUID);
    assert.strictEqual(a, hashToUuid(g.toLowerCase()));
    assert.notStrictEqual(a, hashToUuid('0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f1'));
    assert.ok(!a.includes('0f1e2d3c'));
  });

  if (process.platform === 'win32') {
    await t('real MachineGuid gives a stable UUID (same after "reinstall" = new process state)', async () => {
      const first = await getDeviceId();
      assert.match(String(first), UUID);
      assert.strictEqual(await getDeviceId(), first);
      // «Переустановка» не меняет MachineGuid: свежая загрузка модуля даёт то же значение.
      delete require.cache[require.resolve(path.join(__dirname, '..', '..', 'desktop', 'deviceId.cjs'))];
      const again = await require(path.join(__dirname, '..', '..', 'desktop', 'deviceId.cjs')).getDeviceId();
      assert.strictEqual(again, first);
    });
  } else {
    await t('non-Windows: no device id, so no trial is granted', async () => {
      assert.strictEqual(await getDeviceId(), null);
    });
  }

  console.log(failed ? `\n${failed} FAILED` : '\ndeviceId: all checks passed');
  process.exit(failed ? 1 : 0);
})();
