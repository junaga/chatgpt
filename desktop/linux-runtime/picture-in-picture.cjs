const ACTION_SCHEME = "chatgpt-pip-action:";
const DEFAULT_MAX_DISPLAY_SIZE = 420;
const MAX_IMAGE_URL_BYTES = 64 * 1024 * 1024;

const SKY_ADDON_LOADER_BOUNDARY =
  "function xo({electronAppPath:e,resourcesPath:t}){let n=";
const SKY_ADDON_LOADER_LINUX =
  "function xo({electronAppPath:e,resourcesPath:t}){if(process.platform===`linux`){if(t==null)throw Error(`Linux Picture-in-Picture requires resourcesPath`);return bo(p.default.join(t,`linux-runtime`,`picture-in-picture.cjs`))}let n=";
const PIP_WRAPPER_START = "function Ho({addon:e,controlTooltips:t,";
const PIP_WRAPPER_END = "var os=n.fl({";
const PIP_HOST_WINDOW_BOUNDARY =
  "contentBounds:t.getContentBounds(),id:e,nativeWindowHandle:typeof t.getNativeWindowHandle==`function`?t.getNativeWindowHandle():null";
const PIP_HOST_WINDOW_LINUX =
  "browserWindowId:t.id,contentBounds:t.getContentBounds(),id:e,nativeWindowHandle:typeof t.getNativeWindowHandle==`function`?t.getNativeWindowHandle():null";
const PIP_MANAGER_BOUNDARY = "ae=Cm({isEnabled:ie,isMacOS:j,nativeIntl:";
const PIP_MANAGER_LINUX =
  "ae=Cm({isEnabled:ie,isMacOS:j||process.platform===`linux`,nativeIntl:";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Expected exactly one upstream ${label} boundary`);
  }
  return source.replace(before, after);
}

function enableLinuxPictureInPicture(source) {
  let patched = replaceExactlyOnce(
    source,
    SKY_ADDON_LOADER_BOUNDARY,
    SKY_ADDON_LOADER_LINUX,
    "Sky addon loader",
  );

  const start = patched.indexOf(PIP_WRAPPER_START);
  const end = patched.indexOf(PIP_WRAPPER_END, start);
  if (start === -1 || end === -1 || patched.indexOf(PIP_WRAPPER_START, start + 1) !== -1) {
    throw new Error("Expected exactly one upstream Picture-in-Picture wrapper block");
  }
  const block = patched.slice(start, end);
  let guardCount = 0;
  const linuxBlock = block.replace(/([A-Za-z_$][\w$]*)!==`darwin`/gu, (_match, platform) => {
    guardCount += 1;
    return `${platform}!==\`darwin\`&&${platform}!==\`linux\``;
  });
  if (guardCount !== 18) {
    throw new Error(`Expected 18 upstream Picture-in-Picture platform guards, found ${guardCount}`);
  }
  patched = `${patched.slice(0, start)}${linuxBlock}${patched.slice(end)}`;
  patched = replaceExactlyOnce(
    patched,
    PIP_HOST_WINDOW_BOUNDARY,
    PIP_HOST_WINDOW_LINUX,
    "Picture-in-Picture host window",
  );
  return replaceExactlyOnce(
    patched,
    PIP_MANAGER_BOUNDARY,
    PIP_MANAGER_LINUX,
    "Picture-in-Picture manager",
  );
}

function finiteRectangle(value) {
  if (typeof value !== "object" || value == null) return null;
  const rectangle = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
  return Object.values(rectangle).every(Number.isFinite) && rectangle.width >= 0 && rectangle.height >= 0
    ? rectangle
    : null;
}

function validImageDataUrl(value) {
  return typeof value === "string" &&
    value.length <= MAX_IMAGE_URL_BYTES &&
    /^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/u.test(value);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

function createPictureInPictureHost({
  BrowserWindow,
  desktopCapturer,
  screen,
  environment = process.env,
  logger = console,
  captureIntervalMs = 1_000,
  setInterval_ = setInterval,
  clearInterval_ = clearInterval,
} = {}) {
  if (typeof BrowserWindow !== "function" || !screen) {
    throw new TypeError("Electron BrowserWindow and screen APIs are required");
  }

  const state = {
    activeThreadId: null,
    browserPresentations: new Map(),
    captureError: null,
    captureInFlight: false,
    captureTimer: null,
    completedThreads: new Set(),
    controlTooltips: { hide: "Hide", placement: "Send Picture-in-Picture to Pet" },
    cursorHandler: null,
    cursorIsActive: false,
    desktopPresentations: [],
    hostRegistrations: new Map(),
    maxDisplaySize: DEFAULT_MAX_DISPLAY_SIZE,
    maxDisplaySizeChangedHandler: null,
    petWakeRequestHandler: null,
    selectionOffset: 0,
    started: false,
    suppressedThreadIds: new Set(),
    visibilityRequestHandler: null,
    visible: true,
    window: null,
  };

  function orderedPresentations() {
    const available = [...state.browserPresentations.values()]
      .filter(presentation => !state.suppressedThreadIds.has(presentation.threadId));
    if (state.activeThreadId && !state.suppressedThreadIds.has(state.activeThreadId)) {
      const active = available.filter(presentation => presentation.threadId === state.activeThreadId);
      const others = available.filter(presentation => presentation.threadId !== state.activeThreadId);
      const desktops = [];
      if (!state.completedThreads.has(state.activeThreadId)) {
        if (state.desktopPresentations.length === 0) {
          desktops.push({
            id: `computer-use:${state.activeThreadId}`,
            imageDataUrl: null,
            kind: "computer-use",
            threadId: state.activeThreadId,
            title: "Computer Use",
          });
        } else {
          for (const desktop of state.desktopPresentations) {
            desktops.push({ ...desktop, threadId: state.activeThreadId });
          }
        }
      }
      return [...active, ...desktops, ...others];
    }
    return available;
  }

  function selectedPresentation() {
    const presentations = orderedPresentations();
    if (presentations.length === 0) return null;
    return presentations[state.selectionOffset % presentations.length];
  }

  function selectedHost() {
    return state.hostRegistrations.get("avatar-overlay") ??
      [...state.hostRegistrations.values()].at(-1) ??
      null;
  }

  function displayWorkArea(host) {
    const primary = screen.getPrimaryDisplay();
    const fallback = primary?.workArea ?? { x: 0, y: 0, width: 1280, height: 720 };
    if (!host?.contentBounds || !host?.anchorRect || typeof screen.getDisplayNearestPoint !== "function") {
      return fallback;
    }
    const point = {
      x: Math.round(host.contentBounds.x + host.anchorRect.x + host.anchorRect.width / 2),
      y: Math.round(host.contentBounds.y + host.anchorRect.y + host.anchorRect.height / 2),
    };
    return screen.getDisplayNearestPoint(point)?.workArea ?? fallback;
  }

  function windowBounds(host) {
    const workArea = displayWorkArea(host);
    const maximum = Math.max(220, Math.min(workArea.width - 32, workArea.height - 32, 720));
    const width = Math.round(clamp(state.maxDisplaySize, 220, maximum));
    const height = Math.round(clamp(width * 0.68, 180, Math.max(180, workArea.height - 32)));
    let x = workArea.x + workArea.width - width - 16;
    let y = workArea.y + workArea.height - height - 16;

    if (host?.contentBounds && host?.anchorRect) {
      const anchor = {
        left: host.contentBounds.x + host.anchorRect.x,
        top: host.contentBounds.y + host.anchorRect.y,
        right: host.contentBounds.x + host.anchorRect.x + host.anchorRect.width,
        bottom: host.contentBounds.y + host.anchorRect.y + host.anchorRect.height,
      };
      x = anchor.right + 12;
      y = anchor.top;
      if (x + width > workArea.x + workArea.width) x = anchor.left - width - 12;
      if (x < workArea.x) x = workArea.x + 16;
      if (y + height > workArea.y + workArea.height) y = anchor.bottom - height;
      y = clamp(y, workArea.y + 16, workArea.y + workArea.height - height - 16);
    }
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  function pageHtml(presentation) {
    const presentations = orderedPresentations();
    const image = presentation.imageDataUrl
      ? `<img src="${presentation.imageDataUrl}" alt="${escapeHtml(presentation.title)} preview">`
      : `<div class="empty">${escapeHtml(state.captureError || "Waiting for the desktop preview…")}</div>`;
    const thread = presentation.threadId ? `<span>${escapeHtml(presentation.threadId)}</span>` : "";
    const next = presentations.length > 1
      ? `<a class="control" href="${ACTION_SCHEME}//next" title="Next preview" aria-label="Next preview">›</a>`
      : "";
    const placement = state.petWakeRequestHandler
      ? `<a class="control" href="${ACTION_SCHEME}//pet" title="${escapeHtml(state.controlTooltips.placement)}" aria-label="${escapeHtml(state.controlTooltips.placement)}">↗</a>`
      : "";
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><style>
      :root{color-scheme:dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#111;color:#fff;font:13px system-ui,sans-serif}body{display:grid;grid-template-rows:36px 1fr;border:1px solid #3a3a3a;border-radius:12px}.bar{-webkit-app-region:drag;display:flex;align-items:center;gap:8px;padding:0 8px 0 12px;background:#202020}.title{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.title span{display:block;color:#aaa;font-size:10px;font-weight:400}.controls{-webkit-app-region:no-drag;display:flex;gap:4px;margin-left:auto}.control{display:grid;width:25px;height:25px;place-items:center;border-radius:7px;color:#eee;text-decoration:none;font-size:16px}.control:hover{background:#414141}.preview{-webkit-app-region:no-drag;display:grid;min-height:0;place-items:center;background:#090909;text-decoration:none;color:inherit}.preview img{width:100%;height:100%;object-fit:contain}.empty{padding:24px;color:#bbb;text-align:center}
    </style></head><body><header class="bar"><div class="title">${escapeHtml(presentation.title)}${thread}</div><nav class="controls">${next}${placement}<a class="control" href="${ACTION_SCHEME}//hide" title="${escapeHtml(state.controlTooltips.hide)}" aria-label="${escapeHtml(state.controlTooltips.hide)}">×</a></nav></header><a class="preview" href="${ACTION_SCHEME}//focus" title="Open this thread">${image}</a></body></html>`;
  }

  function handleAction(event, target) {
    if (typeof target !== "string" || !target.startsWith(ACTION_SCHEME)) return;
    event?.preventDefault?.();
    const action = new URL(target).hostname;
    const presentation = selectedPresentation();
    if (action === "next") {
      state.selectionOffset += 1;
      render();
      return;
    }
    if (action === "pet") {
      state.petWakeRequestHandler?.();
      return;
    }
    if (action === "focus") {
      const ownerId = selectedHost()?.browserWindowId;
      const owner = Number.isSafeInteger(ownerId) ? BrowserWindow.fromId?.(ownerId) : null;
      owner?.show?.();
      owner?.focus?.();
      return;
    }
    if (action !== "hide") return;
    const threadIds = presentation?.threadId ? [presentation.threadId] : [];
    for (const threadId of threadIds) state.suppressedThreadIds.add(threadId);
    state.visibilityRequestHandler?.(false, threadIds);
    render();
  }

  function ensureWindow() {
    if (state.window && !state.window.isDestroyed()) return state.window;
    const window = new BrowserWindow({
      acceptFirstMouse: true,
      alwaysOnTop: true,
      backgroundColor: "#111111",
      frame: false,
      fullscreenable: false,
      height: 286,
      maximizable: false,
      minimizable: false,
      resizable: true,
      show: false,
      skipTaskbar: true,
      title: "ChatGPT Picture-in-Picture",
      useContentSize: true,
      width: DEFAULT_MAX_DISPLAY_SIZE,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    state.window = window;
    window.setAlwaysOnTop?.(true);
    window.setMenuBarVisibility?.(false);
    try {
      window.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true });
    } catch (error) {
      logger.warn?.("Linux compositor does not support PiP on every workspace", error);
    }
    window.webContents?.on?.("will-navigate", handleAction);
    window.on?.("resize", () => {
      if (window.isDestroyed()) return;
      const bounds = window.getBounds();
      const size = Math.max(bounds.width, bounds.height);
      if (!Number.isFinite(size) || size <= 0 || size === state.maxDisplaySize) return;
      state.maxDisplaySize = size;
      state.maxDisplaySizeChangedHandler?.(size);
    });
    window.on?.("closed", () => {
      if (state.window === window) state.window = null;
    });
    return window;
  }

  function setCursorActive(active) {
    if (!state.cursorHandler || state.cursorIsActive === active && !active) return;
    state.cursorIsActive = active;
    const point = typeof screen.getCursorScreenPoint === "function"
      ? screen.getCursorScreenPoint()
      : { x: 0, y: 0 };
    state.cursorHandler({ isActive: active, x: point.x, y: point.y });
  }

  function render() {
    const presentation = selectedPresentation();
    if (!state.started || !state.visible || !presentation) {
      state.window?.hide?.();
      setCursorActive(false);
      return;
    }
    const window = ensureWindow();
    const bounds = windowBounds(selectedHost());
    window.setBounds?.(bounds, false);
    const url = `data:text/html;charset=utf-8,${encodeURIComponent(pageHtml(presentation))}`;
    Promise.resolve(window.loadURL(url)).catch(error => {
      logger.warn?.("Unable to render Linux Picture-in-Picture", error);
    });
    window.showInactive?.();
    setCursorActive(presentation.kind === "computer-use");
  }

  async function captureDesktop() {
    if (state.captureInFlight || !desktopCapturer?.getSources) return;
    const presentation = selectedPresentation();
    if (presentation?.kind !== "computer-use" || !state.started || !state.visible) return;
    state.captureInFlight = true;
    try {
      const size = Math.round(clamp(state.maxDisplaySize * 2, 640, 1440));
      const sources = await desktopCapturer.getSources({
        fetchWindowIcons: false,
        thumbnailSize: { width: size, height: size },
        types: ["screen"],
      });
      const primaryId = String(screen.getPrimaryDisplay?.()?.id ?? "");
      const orderedSources = [...sources].sort((left, right) =>
        Number(String(right.display_id ?? "") === primaryId) - Number(String(left.display_id ?? "") === primaryId));
      const desktops = orderedSources.flatMap((source, index) => {
        const imageDataUrl = source?.thumbnail?.toDataURL?.();
        return validImageDataUrl(imageDataUrl) ? [{
          id: `computer-use:${state.activeThreadId}:${String(source.display_id ?? index)}`,
          imageDataUrl,
          kind: "computer-use",
          title: orderedSources.length === 1 ? "Computer Use" : `Computer Use — Display ${index + 1}`,
        }] : [];
      });
      if (desktops.length === 0) {
        throw new Error("the compositor returned no screen thumbnail");
      }
      state.desktopPresentations = desktops;
      state.captureError = null;
      render();
    } catch (error) {
      state.captureError = `Desktop preview unavailable: ${error instanceof Error ? error.message : String(error)}`;
      logger.warn?.("Unable to capture Linux Computer Use PiP preview", error);
      // A denied Wayland ScreenCast request can present a chooser. Do not
      // repeatedly reopen it; a new turn or explicit invalidation can retry.
      if (environment.XDG_SESSION_TYPE?.toLowerCase() === "wayland" && state.captureTimer != null) {
        clearInterval_(state.captureTimer);
        state.captureTimer = null;
      }
      render();
    } finally {
      state.captureInFlight = false;
    }
  }

  function reconcileCaptureTimer() {
    const needsCapture = state.started && state.visible && selectedPresentation()?.kind === "computer-use";
    if (!needsCapture) {
      if (state.captureTimer != null) clearInterval_(state.captureTimer);
      state.captureTimer = null;
      return;
    }
    if (captureIntervalMs <= 0) {
      void captureDesktop();
    } else if (state.captureTimer == null) {
      // Give Browser Use metadata a moment to arrive before asking for a
      // desktop capture. Browser presentations replace this timer immediately.
      state.captureTimer = setInterval_(() => void captureDesktop(), captureIntervalMs);
      state.captureTimer?.unref?.();
    }
  }

  function reconcile() {
    render();
    reconcileCaptureTimer();
  }

  const api = {
    startRemoteHostedPIPContentHost(tooltips = {}) {
      if (typeof tooltips !== "object" || tooltips == null) return false;
      state.controlTooltips = {
        hide: typeof tooltips.hide === "string" ? tooltips.hide : "Hide",
        placement: typeof tooltips.placement === "string" ? tooltips.placement : "Send Picture-in-Picture to Pet",
      };
      state.started = true;
      reconcile();
      return true;
    },

    stopRemoteHostedPIPContentHost() {
      state.started = false;
      if (state.captureTimer != null) clearInterval_(state.captureTimer);
      state.captureTimer = null;
      setCursorActive(false);
      state.window?.destroy?.();
      state.window = null;
      state.browserPresentations.clear();
      state.desktopPresentations = [];
      state.captureError = null;
      return true;
    },

    setRemoteHostedPIPContentActiveThreadID(threadId) {
      if (threadId != null && typeof threadId !== "string") return false;
      if (state.activeThreadId !== threadId) {
        state.desktopPresentations = [];
        state.captureError = null;
      }
      state.activeThreadId = threadId;
      if (threadId) state.completedThreads.delete(threadId);
      state.selectionOffset = 0;
      reconcile();
      return true;
    },

    setRemoteHostedPIPContentSuppressedThreadIDs(threadIds) {
      if (!Array.isArray(threadIds) || !threadIds.every(threadId => typeof threadId === "string")) return false;
      state.suppressedThreadIds = new Set(threadIds);
      reconcile();
      return true;
    },

    setRemoteHostedPIPContentMaxDisplaySize(size) {
      if (!Number.isFinite(size) || size <= 0) return false;
      state.maxDisplaySize = size;
      reconcile();
      return true;
    },

    setRemoteHostedPIPContentMaxDisplaySizeChangedHandler(handler) {
      if (handler != null && typeof handler !== "function") return false;
      state.maxDisplaySizeChangedHandler = handler;
      return true;
    },

    hasRemoteHostedPIPContentActivePresentation() {
      const presentation = selectedPresentation();
      return Boolean(presentation && state.activeThreadId && presentation.threadId === state.activeThreadId);
    },

    hasRemoteHostedPIPContentAnyPresentation() {
      return orderedPresentations().length > 0;
    },

    setRemoteHostedPIPContentVisible(visible) {
      if (typeof visible !== "boolean") return false;
      state.visible = visible;
      reconcile();
      return true;
    },

    setRemoteHostedPIPContentPetWakeRequestHandler(handler) {
      if (handler != null && typeof handler !== "function") return false;
      state.petWakeRequestHandler = handler;
      render();
      return true;
    },

    setRemoteHostedPIPContentVisibilityRequestHandler(handler) {
      if (handler != null && typeof handler !== "function") return false;
      state.visibilityRequestHandler = handler;
      return true;
    },

    setRemoteHostedPIPContentComputerUseCursorLocationHandler(handler) {
      if (handler != null && typeof handler !== "function") return false;
      state.cursorHandler = handler;
      if (handler == null) state.cursorIsActive = false;
      else setCursorActive(selectedPresentation()?.kind === "computer-use");
      return true;
    },

    registerRemoteHostedPIPContentHost(host) {
      if (typeof host?.id !== "string" || host.id.trim() === "") return false;
      const contentBounds = finiteRectangle(host.contentBounds);
      const anchorRect = finiteRectangle(host.anchorRect);
      if (!contentBounds || !anchorRect) return false;
      state.hostRegistrations.set(host.id, {
        ...host,
        anchorRect,
        contentBounds,
      });
      reconcile();
      return true;
    },

    unregisterRemoteHostedPIPContentHost(hostId) {
      if (typeof hostId !== "string" || hostId.trim() === "") return false;
      state.hostRegistrations.delete(hostId);
      reconcile();
      return true;
    },

    completeRemoteHostedPIPContentThread(threadId) {
      if (typeof threadId !== "string" || threadId.trim() === "") return false;
      state.completedThreads.add(threadId);
      for (const [id, presentation] of state.browserPresentations) {
        if (presentation.threadId === threadId) state.browserPresentations.delete(id);
      }
      reconcile();
      return true;
    },

    invalidateRemoteHostedPIPContentTurn(threadId, turnId) {
      if (typeof threadId !== "string" || threadId.trim() === "" || typeof turnId !== "string" || turnId.trim() === "") {
        return false;
      }
      if (state.activeThreadId === threadId) void captureDesktop();
      return true;
    },

    upsertBrowserUsePIPContent(presentationId, threadId, imageDataUrl, appIconPath) {
      if (
        typeof presentationId !== "string" || presentationId.trim() === "" ||
        typeof threadId !== "string" || threadId.trim() === "" ||
        !validImageDataUrl(imageDataUrl) ||
        appIconPath != null && typeof appIconPath !== "string"
      ) {
        return false;
      }
      state.browserPresentations.delete(presentationId);
      state.browserPresentations.set(presentationId, {
        appIconPath: appIconPath ?? null,
        id: presentationId,
        imageDataUrl,
        kind: "browser-use",
        threadId,
        title: "Browser Use",
      });
      state.completedThreads.delete(threadId);
      reconcile();
      return true;
    },

    invalidateBrowserUsePIPContent(presentationId) {
      if (typeof presentationId !== "string" || presentationId.trim() === "") return false;
      state.browserPresentations.delete(presentationId);
      reconcile();
      return true;
    },
  };

  return Object.freeze(api);
}

let defaultHost;
function getDefaultHost() {
  if (!defaultHost) {
    const { BrowserWindow, desktopCapturer, screen } = require("electron");
    defaultHost = createPictureInPictureHost({ BrowserWindow, desktopCapturer, screen });
  }
  return defaultHost;
}

const nativeMethods = [
  "startRemoteHostedPIPContentHost",
  "stopRemoteHostedPIPContentHost",
  "setRemoteHostedPIPContentActiveThreadID",
  "setRemoteHostedPIPContentSuppressedThreadIDs",
  "setRemoteHostedPIPContentMaxDisplaySize",
  "setRemoteHostedPIPContentMaxDisplaySizeChangedHandler",
  "hasRemoteHostedPIPContentActivePresentation",
  "hasRemoteHostedPIPContentAnyPresentation",
  "setRemoteHostedPIPContentVisible",
  "setRemoteHostedPIPContentPetWakeRequestHandler",
  "setRemoteHostedPIPContentVisibilityRequestHandler",
  "setRemoteHostedPIPContentComputerUseCursorLocationHandler",
  "registerRemoteHostedPIPContentHost",
  "unregisterRemoteHostedPIPContentHost",
  "completeRemoteHostedPIPContentThread",
  "invalidateRemoteHostedPIPContentTurn",
  "upsertBrowserUsePIPContent",
  "invalidateBrowserUsePIPContent",
];

module.exports = {
  ACTION_SCHEME,
  createPictureInPictureHost,
  enableLinuxPictureInPicture,
};
for (const method of nativeMethods) {
  module.exports[method] = (...arguments_) => getDefaultHost()[method](...arguments_);
}
