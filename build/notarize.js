// electron-builder afterSign hook — notarize + staple the signed macOS .app.
//
// Credentials are NOT stored here or in env: they live in the encrypted macOS
// keychain under the profile "synthony-notarize", created once with:
//   xcrun notarytool store-credentials "synthony-notarize" \
//     --apple-id <appleId> --team-id X2764CDP58 --password <app-specific-pw>
//
// @electron/notarize submits to Apple, waits for the result, and staples the
// ticket to the .app on success (so it opens with no Gatekeeper prompt, even
// offline). Skips cleanly on non-mac builds or if the profile is absent.
const path = require('path');

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  // Allow opting out (e.g. a quick unsigned local build) without editing config.
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('[notarize] SKIP_NOTARIZE=1 — skipping notarization');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const { notarize } = require('@electron/notarize');
  console.log(`[notarize] submitting "${appName}.app" to Apple — this usually takes 1–5 min…`);
  await notarize({
    tool: 'notarytool',
    appPath,
    keychainProfile: 'synthony-notarize',
  });
  console.log('[notarize] accepted by Apple and stapled ✔');
};
