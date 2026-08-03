function isWaylandSession(environment = process.env) {
  const sessionType = environment.XDG_SESSION_TYPE?.trim().toLowerCase();
  if (sessionType) return sessionType === "wayland";
  return Boolean(environment.WAYLAND_DISPLAY?.trim());
}

function configureNativeWayland(app, { environment = process.env } = {}) {
  if (!isWaylandSession(environment)) return false;
  if (app.commandLine.hasSwitch("ozone-platform")) return false;
  app.commandLine.appendSwitch("ozone-platform", "wayland");
  return true;
}

module.exports = { configureNativeWayland, isWaylandSession };
