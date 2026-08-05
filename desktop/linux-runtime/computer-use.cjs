// Open the upstream Computer Use feature path on Linux while preserving its
// node_repl sandbox and plugin confirmation policy. These boundaries are
// deliberately assertion checked against the pinned upstream bundle.

const LINUX_CLIENT_SHA256 =
  "42ee527f13910d50e3b688b12c72db08d8c42514392144fe773f5d2d359d26d8";

const FEATURE_NORMALIZATION =
  "let i=r===`win32`&&e.computerUse===!0?{...e,computerUseNodeRepl:!0}:e,o=r===`win32`&&n.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...i,computerUse:!0,computerUseNodeRepl:!0}:i";
const LINUX_FEATURE_NORMALIZATION =
  "let i=r===`win32`&&e.computerUse===!0?{...e,computerUseNodeRepl:!0}:e,o=r===`linux`?{...i,computerUse:!0,computerUseNodeRepl:!0}:r===`win32`&&n.CODEX_ELECTRON_ENABLE_WINDOWS_COMPUTER_USE===`1`?{...i,computerUse:!0,computerUseNodeRepl:!0}:i";

const PLUGIN_AVAILABILITY =
  "isAvailable:({features:e,platform:t})=>t===`win32`&&e.computerUse";
const LINUX_PLUGIN_AVAILABILITY =
  "isAvailable:({features:e,platform:t})=>(t===`win32`||t===`linux`)&&e.computerUse";

const SKILL_VARIANT =
  "function Au(e){if(!(e.platform!==`darwin`||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}";
const LINUX_SKILL_VARIANT =
  "function Au(e){if(!((e.platform!==`darwin`&&e.platform!==`linux`)||!e.marketplacePluginNames.includes(`computer-use`)))return e.desktopFeatureAvailability.computerUseNodeRepl?`node-repl`:`legacy-mcp`}";

const TRUSTED_CLIENTS =
  "Or=[`091a81603ff202a16ed56557709bf42d97caf8f0dd2e07ae9e26d7c014d71035`]";
const LINUX_TRUSTED_CLIENTS =
  `Or=[\`091a81603ff202a16ed56557709bf42d97caf8f0dd2e07ae9e26d7c014d71035\`,\`${LINUX_CLIENT_SHA256}\`]`;

const TRUST_SELECTION =
  "let T=g||_&&(y.platform===`darwin`||w)?h:[]";
const LINUX_TRUST_SELECTION =
  "let T=g||_&&(y.platform===`darwin`||y.platform===`linux`||w)?h:[]";

const COMPUTER_USE_INSTRUCTIONS =
  "...r&&l.platform===`darwin`?{[ti]:ite}:{}";
const LINUX_COMPUTER_USE_INSTRUCTIONS =
  "...r&&(l.platform===`darwin`||l.platform===`linux`)?{[ti]:l.platform===`linux`?`Control desktop apps on Linux through Computer Use.`:ite}:{}";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Expected exactly one upstream ${label} boundary`);
  }
  return source.replace(before, after);
}

function enableLinuxComputerUse(source) {
  let patched = replaceExactlyOnce(
    source,
    FEATURE_NORMALIZATION,
    LINUX_FEATURE_NORMALIZATION,
    "Computer Use feature normalization",
  );
  patched = replaceExactlyOnce(
    patched,
    PLUGIN_AVAILABILITY,
    LINUX_PLUGIN_AVAILABILITY,
    "Computer Use plugin availability",
  );
  patched = replaceExactlyOnce(
    patched,
    SKILL_VARIANT,
    LINUX_SKILL_VARIANT,
    "Computer Use skill variant",
  );
  patched = replaceExactlyOnce(
    patched,
    TRUSTED_CLIENTS,
    LINUX_TRUSTED_CLIENTS,
    "trusted Computer Use client list",
  );
  patched = replaceExactlyOnce(
    patched,
    TRUST_SELECTION,
    LINUX_TRUST_SELECTION,
    "Computer Use trusted-code selection",
  );
  return replaceExactlyOnce(
    patched,
    COMPUTER_USE_INSTRUCTIONS,
    LINUX_COMPUTER_USE_INSTRUCTIONS,
    "Computer Use instructions",
  );
}

module.exports = { LINUX_CLIENT_SHA256, enableLinuxComputerUse };
