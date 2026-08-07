const fs = require("node:fs");
const path = require("node:path");

function installMediaTracing({ app, contentTracing }) {
  if (process.env.CODEX_LINUX_MEDIA_TRACE !== "1") return;

  let recording = false;
  let snapshotting = false;
  const traceDirectory = path.join(app.getPath("userData"), "traces");

  async function start() {
    await fs.promises.mkdir(traceDirectory, { recursive: true });
    await contentTracing.startRecording({
      included_categories: [
        "webrtc",
        "webrtc_stats",
        "audio",
        "media",
        "toplevel",
        "blink",
        "renderer.scheduler",
      ],
    });
    recording = true;
    console.log("[voice-trace] native Electron media tracing started");
  }

  async function snapshot(reason) {
    if (!recording || snapshotting) return;
    snapshotting = true;
    try {
      const filename = `voice-media-${Date.now()}-${reason}.json`;
      const destination = path.join(traceDirectory, filename);
      await contentTracing.stopRecording(destination);
      recording = false;
      console.log(`[voice-trace] saved ${destination}`);
      await start();
    } catch (error) {
      console.warn("[voice-trace] snapshot failed", error);
    } finally {
      snapshotting = false;
    }
  }

  app.whenReady().then(start).catch(error => console.warn("[voice-trace] start failed", error));
  process.on("SIGUSR1", () => { void snapshot("signal"); });
  app.on("before-quit", () => { void snapshot("quit"); });
}

module.exports = { installMediaTracing };
