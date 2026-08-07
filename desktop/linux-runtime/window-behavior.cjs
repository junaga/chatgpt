const PRIMARY_WINDOW_OPTIONS_BOUNDARY =
  "n===`win32`||n===`linux`?{titleBarStyle:`hidden`,titleBarOverlay:A9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}}";
const PRIMARY_WINDOW_OPTIONS_LINUX =
  "n===`win32`?{titleBarStyle:`hidden`,titleBarOverlay:A9(r),...e===`quickChat`?{resizable:!0}:{}}:{titleBarStyle:`default`,...e===`quickChat`?{resizable:!0}:{}}";

const PRIMARY_TITLEBAR_OVERLAY_UPDATE_BOUNDARY =
  "(process.platform===`win32`||process.platform===`linux`)&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(A9(t)))";
const PRIMARY_TITLEBAR_OVERLAY_UPDATE_LINUX =
  "process.platform===`win32`&&(this.windowZooms.set(n.id,t),n.setTitleBarOverlay(A9(t)))";

const PRIMARY_TITLEBAR_OVERLAY_INSTALL_BOUNDARY =
  "if(process.platform!==`win32`&&process.platform!==`linux`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(A9(this.windowZooms.get(e.id)))};";
const PRIMARY_TITLEBAR_OVERLAY_INSTALL_LINUX =
  "if(process.platform!==`win32`||t!==`primary`&&t!==`quickChat`)return;let n=()=>{e.isDestroyed()||e.setTitleBarOverlay(A9(this.windowZooms.get(e.id)))};";

const PRIMARY_CLOSE_TO_TRAY_BOUNDARY =
  "if((process.platform===`win32`||process.platform===`linux`)&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t)";
const PRIMARY_CLOSE_TO_TRAY_LINUX =
  "if(process.platform===`win32`&&!this.isAppQuitting&&this.options.canHideLastWindowToTray?.()===!0&&!t)";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Expected exactly one upstream ${label} boundary`);
  }
  return source.replace(before, after);
}

// The upstream Linux branch intentionally follows Windows' client-side titlebar
// and tray behavior. Under Linux compositors this makes the overlay controls
// unreadable and turns the window close button into a hidden background app.
function enableNativeLinuxWindowBehavior(source) {
  const patched = replaceExactlyOnce(
    replaceExactlyOnce(
      replaceExactlyOnce(
        source,
        PRIMARY_WINDOW_OPTIONS_BOUNDARY,
        PRIMARY_WINDOW_OPTIONS_LINUX,
        "primary-window titlebar options",
      ),
      PRIMARY_TITLEBAR_OVERLAY_UPDATE_BOUNDARY,
      PRIMARY_TITLEBAR_OVERLAY_UPDATE_LINUX,
      "primary-window titlebar overlay update",
    ),
    PRIMARY_TITLEBAR_OVERLAY_INSTALL_BOUNDARY,
    PRIMARY_TITLEBAR_OVERLAY_INSTALL_LINUX,
    "primary-window titlebar overlay installer",
  );
  return replaceExactlyOnce(
    patched,
    PRIMARY_CLOSE_TO_TRAY_BOUNDARY,
    PRIMARY_CLOSE_TO_TRAY_LINUX,
    "primary-window close-to-tray handler",
  );
}

module.exports = { enableNativeLinuxWindowBehavior };
