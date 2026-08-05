const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const FLATPAK_APP_ID = "io.github.junaga.chatgpt";
const FLATPAK_APP_ROOT = `/app/lib/${FLATPAK_APP_ID}`;
const NATIVE_HOST_OVERRIDE = "CHATGPT_LINUX_NATIVE_HOST_WRAPPER";
const NATIVE_HOST_CONFIG_HOME_OVERRIDE = "CHATGPT_LINUX_NATIVE_HOST_CONFIG_HOME";

function isFlatpak() {
  return process.env.FLATPAK_ID === FLATPAK_APP_ID || fs.existsSync("/.flatpak-info");
}

function assertOwnerOnlyDirectory(directory) {
  const entry = fs.lstatSync(directory);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe Chrome host directory: ${directory}`);
  if (typeof process.getuid === "function" && entry.uid !== process.getuid()) {
    throw new Error(`Chrome host directory has a different owner: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function wrapperSource({
  flatpak = isFlatpak(),
  resourcesPath = path.resolve(__dirname, ".."),
} = {}) {
  if (flatpak) {
    return `#!/bin/sh
set -eu

exec flatpak run \\
  --command=/app/bin/codex-desktop \\
  --env=ELECTRON_RUN_AS_NODE=1 \\
  --env=CHATGPT_LINUX_EXTENSION_HOST_PATH="$0" \\
  ${FLATPAK_APP_ID} \\
  ${FLATPAK_APP_ROOT}/resources/linux-runtime/chrome-extension-host.mjs "$@"
`;
  }

  const resources = shellQuote(path.resolve(resourcesPath));
  return `#!/bin/sh
set -eu

resources=${resources}
CHATGPT_LINUX_EXTENSION_HOST_PATH="$0" \\
  exec "$resources/cua_node/bin/node" "$resources/linux-runtime/chrome-extension-host.mjs" "$@"
`;
}

function installOwnerOnlyFile(destination, contents) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o700 });
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o700);
  } finally {
    try { fs.unlinkSync(temporary); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function prepareChromeNativeHost(options = {}) {
  const flatpak = options.flatpak ?? isFlatpak();
  const directory = options.directory || path.join(os.homedir(), ".local", "share", "chatgpt", "chrome-native-host");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertOwnerOnlyDirectory(directory);
  const wrapper = path.join(directory, "extension-host");
  installOwnerOnlyFile(wrapper, wrapperSource({ flatpak, resourcesPath: options.resourcesPath }));
  process.env[NATIVE_HOST_OVERRIDE] = wrapper;
  if (flatpak) {
    // Flatpak replaces XDG_CONFIG_HOME with its private per-app directory. The
    // host browser reads native-messaging manifests from the host config home.
    process.env[NATIVE_HOST_CONFIG_HOME_OVERRIDE] = path.join(os.homedir(), ".config");
  } else {
    delete process.env[NATIVE_HOST_CONFIG_HOME_OVERRIDE];
  }
  return wrapper;
}

function patchChromeInstallManifestSource(source) {
  const replacements = [
    ["extensionHostPath:_(t)", `extensionHostPath:process.env.${NATIVE_HOST_OVERRIDE}||_(t)`],
    ["xdgConfigHome:w.env.XDG_CONFIG_HOME", `xdgConfigHome:process.env.${NATIVE_HOST_CONFIG_HOME_OVERRIDE}||w.env.XDG_CONFIG_HOME`],
  ];
  let patched = source;
  for (const [original, replacement] of replacements) {
    const occurrences = patched.split(original).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Expected exactly one Chrome install-manifest expression ${original}; found ${occurrences}`);
    }
    patched = patched.replace(original, replacement);
  }
  return patched;
}

function enableLinuxChromeNativeHostLifecycle(source) {
  const replacements = [
    [
      "r=await Hq({pluginRoot:e.pluginRoot,target:n})",
      `r=process.env.${NATIVE_HOST_OVERRIDE}||await Hq({pluginRoot:e.pluginRoot,target:n})`,
    ],
    [
      "defaultConfigHome:(0,i.join)(r.default.homedir(),`.config`),xdgConfigHome:process.env.XDG_CONFIG_HOME}).map",
      `defaultConfigHome:(0,i.join)(r.default.homedir(),\`.config\`),xdgConfigHome:process.env.${NATIVE_HOST_CONFIG_HOME_OVERRIDE}||process.env.XDG_CONFIG_HOME}).map`,
    ],
  ];
  let patched = source;
  for (const [original, replacement] of replacements) {
    const occurrences = patched.split(original).length - 1;
    if (occurrences !== 1) {
      throw new Error(`Expected exactly one Chrome native-host lifecycle expression ${original}; found ${occurrences}`);
    }
    patched = patched.replace(original, replacement);
  }
  return patched;
}

module.exports = {
  FLATPAK_APP_ID,
  FLATPAK_APP_ROOT,
  NATIVE_HOST_CONFIG_HOME_OVERRIDE,
  NATIVE_HOST_OVERRIDE,
  enableLinuxChromeNativeHostLifecycle,
  isFlatpak,
  patchChromeInstallManifestSource,
  prepareChromeNativeHost,
  shellQuote,
  wrapperSource,
};
