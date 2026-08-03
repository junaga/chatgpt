const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REVISION_7_MARKER = ".chatgpt-linux-port-7-migrated";

function migrateRevision6PetWake({
  environment = process.env,
  fileSystem = fs,
  homeDirectory = os.homedir(),
  logger = console,
} = {}) {
  const configuredHome = environment.CODEX_HOME?.trim();
  const codexHome = configuredHome || path.join(homeDirectory, ".codex");
  const marker = path.join(codexHome, REVISION_7_MARKER);
  const stateFile = path.join(codexHome, ".codex-global-state.json");
  if (fileSystem.existsSync(marker) || !fileSystem.existsSync(stateFile)) return false;

  let state;
  try {
    state = JSON.parse(fileSystem.readFileSync(stateFile, "utf8"));
  } catch (error) {
    logger.warn?.("Could not read global state for the revision 7 migration", error);
    return false;
  }

  let changed = false;
  if (state?.["electron-avatar-overlay-open"] === true) {
    state["electron-avatar-overlay-open"] = false;
    const temporary = `${stateFile}.${process.pid}.port-7.tmp`;
    try {
      fileSystem.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      fileSystem.renameSync(temporary, stateFile);
      changed = true;
    } catch (error) {
      try { fileSystem.unlinkSync(temporary); } catch {}
      logger.warn?.("Could not clear the stale revision 6 pet state", error);
      return false;
    }
  }

  try {
    fileSystem.writeFileSync(marker, "Cleared the revision 6 automatic pet wake state.\n", {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      logger.warn?.("Could not record the revision 7 state migration", error);
    }
  }
  return changed;
}

module.exports = { migrateRevision6PetWake, REVISION_7_MARKER };
