// electron-builder afterPack hook: flip Electron fuses to safe defaults.
// Runs after each platform pack, before signing.
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

  const exeName = context.packager.appInfo.productFilename + '.exe';
  const exePath = path.join(context.appOutDir, exeName);

  console.log('Flipping fuses on:', exePath);

  await flipFuses(exePath, {
    version: FuseVersion.V1,
    // Целостность app.asar: electron-builder 25 встраивает в exe дайджест заголовка asar
    // (в логе сборки: «updating asar integrity executable resource»), Electron сверяет его
    // при старте. По умолчанию ВЫКЛЮЧЕНО: включение нельзя проверить без запуска собранного
    // exe (неподписанный exe блокируют Smart App Control / AppLocker), а при сбое приложение
    // просто не стартует у всех. Смоук-тест в CI (tests/desktop/smoke.cjs, job desktop-smoke)
    // собирает с SIM_ASAR_INTEGRITY=1 и запускает результат; когда он зелёный, можно сделать
    // это значение по умолчанию.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: process.env.SIM_ASAR_INTEGRITY === '1',
    // Приложение упаковано в app.asar (asar: true в electron-builder.yml) — грузим только
    // из него: подложенная рядом папка app/ с чужим кодом игнорируется.
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // Подписанный SimProxy.exe нельзя превратить в обычный Node (ELECTRON_RUN_AS_NODE):
    // иначе он годится как «легитимный» интерпретатор для запуска произвольного кода.
    // Приложение этим режимом не пользуется (ядра — отдельные xray.exe/mihomo.exe).
    [FuseV1Options.RunAsNode]: false,
    // Аналогично: NODE_OPTIONS и --inspect позволяли бы подмешать код в процесс снаружи.
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
  });

  console.log('Fuses flipped OK');
};
