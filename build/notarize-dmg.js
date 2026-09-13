// electron-builder afterAllArtifactBuild hook — notarize + staple the .dmg.
//
// The afterSign hook (build/notarize.js) notarizes the .app *inside* the image;
// this notarizes the disk-image *container* so even mounting the downloaded DMG
// is prompt-free. Same keychain profile ("synthony-notarize") — no secrets in
// the repo or env. Set SKIP_NOTARIZE=1 to skip (quick local builds).
const { execFileSync } = require('child_process');

exports.default = async function notarizeDmg(buildResult) {
  if (process.env.SKIP_NOTARIZE === '1') {
    console.log('[notarize-dmg] SKIP_NOTARIZE=1 — skipping DMG notarization');
    return [];
  }
  const dmgs = (buildResult.artifactPaths || []).filter((p) => p.endsWith('.dmg'));
  for (const dmg of dmgs) {
    console.log(`[notarize-dmg] submitting "${dmg}" to Apple — this can take a few minutes…`);
    execFileSync('xcrun', ['notarytool', 'submit', dmg, '--keychain-profile', 'synthony-notarize', '--wait'], { stdio: 'inherit' });
    execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' });
    console.log(`[notarize-dmg] notarized + stapled "${dmg}" ✔`);
  }
  return [];
};
