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
    // Disable ASAR integrity so a hash mismatch never silently kills startup.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    // Allow loading from plain directory (asar: false builds / dev mode).
    [FuseV1Options.OnlyLoadAppFromAsar]: false,
  });

  console.log('Fuses flipped OK');
};
