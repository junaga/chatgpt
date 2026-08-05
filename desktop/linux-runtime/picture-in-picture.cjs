const ACTION_SCHEME = "chatgpt-pip-action:";
const DEFAULT_MAX_DISPLAY_SIZE = 420;
const MAX_IMAGE_URL_BYTES = 64 * 1024 * 1024;

const SKY_ADDON_LOADER_BOUNDARY =
  "function go({electronAppPath:e,resourcesPath:t}){let n=";
const SKY_ADDON_LOADER_LINUX =
  "function go({electronAppPath:e,resourcesPath:t}){if(process.platform===`linux`){if(t==null)throw Error(`Linux Picture-in-Picture requires resourcesPath`);return ho(p.default.join(t,`linux-runtime`,`picture-in-picture.cjs`))}let n=";
const PIP_WRAPPER_START = "function Lo({addon:e,controlTooltips:t,";
const PIP_WRAPPER_END = "var ns=n.nl({";
const PIP_HOST_WINDOW_BOUNDARY =
  "contentBounds:t.getContentBounds(),id:e,nativeWindowHandle:typeof t.getNativeWindowHandle==`function`?t.getNativeWindowHandle():null";
const PIP_HOST_WINDOW_LINUX =
  "browserWindowId:t.id,contentBounds:t.getContentBounds(),id:e,nativeWindowHandle:typeof t.getNativeWindowHandle==`function`?t.getNativeWindowHandle():null";
const PIP_MANAGER_BOUNDARY = "isEnabled:oe,isMacOS:M,nativeIntl:";
const PIP_MANAGER_LINUX =
  "isEnabled:oe,isMacOS:M||process.platform===`linux`,nativeIntl:";
const PIP_SUBSCRIPTION_BOUNDARY =
  "F.add(as({appServerConnection:Ae(),isEnabled:oe})),F.add(wre({appServerConnection:Ae(),closeActiveTurn:ze.closeActiveTurn}));";
const PIP_SUBSCRIPTION_LINUX =
  "F.add(as({appServerConnection:Ae(),isEnabled:oe})),process.platform===`linux`&&F.add(require(p.default.join(process.resourcesPath,`linux-runtime`,`picture-in-picture.cjs`)).subscribeComputerUsePIPMetadata(Ae())),F.add(wre({appServerConnection:Ae(),closeActiveTurn:ze.closeActiveTurn}));";

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
  if (guardCount !== 19) {
    throw new Error(`Expected 19 upstream Picture-in-Picture platform guards, found ${guardCount}`);
  }
  patched = `${patched.slice(0, start)}${linuxBlock}${patched.slice(end)}`;
  patched = replaceExactlyOnce(
    patched,
    PIP_HOST_WINDOW_BOUNDARY,
    PIP_HOST_WINDOW_LINUX,
    "Picture-in-Picture host window",
  );
  patched = replaceExactlyOnce(
    patched,
    PIP_MANAGER_BOUNDARY,
    PIP_MANAGER_LINUX,
    "Picture-in-Picture manager",
  );
  return replaceExactlyOnce(
    patched,
    PIP_SUBSCRIPTION_BOUNDARY,
    PIP_SUBSCRIPTION_LINUX,
    "Picture-in-Picture Computer Use subscription",
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
  screen,
  logger = console,
} = {}) {
  if (typeof BrowserWindow !== "function" || !screen) {
    throw new TypeError("Electron BrowserWindow and screen APIs are required");
  }

  const state = {
    activeThreadId: null,
    browserPresentations: new Map(),
    computerUsePresentations: new Map(),
    controlTooltips: { hide: "Hide", placement: "Send Picture-in-Picture to Pet" },
    cursorHandler: null,
    cursorIsActive: false,
    hostRegistrations: new Map(),
    hostProcessIdentifier: null,
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
    const available = [
      ...state.browserPresentations.values(),
      ...state.computerUsePresentations.values(),
    ]
      .filter(presentation => !state.suppressedThreadIds.has(presentation.threadId));
    if (state.activeThreadId && !state.suppressedThreadIds.has(state.activeThreadId)) {
      const active = available.filter(presentation => presentation.threadId === state.activeThreadId);
      const others = available.filter(presentation => presentation.threadId !== state.activeThreadId);
      return [...active, ...others];
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
      : `<div class="empty">Preview unavailable</div>`;
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

  function reconcile() {
    render();
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

    connectRemoteHostedPIPContentHost(processIdentifier) {
      if (!Number.isSafeInteger(processIdentifier) || processIdentifier <= 0) return false;
      // macOS connects its out-of-process Sky service here. Linux hosts PiP in
      // this Electron process, so the equivalent connection is already live.
      state.hostProcessIdentifier = processIdentifier;
      return true;
    },

    stopRemoteHostedPIPContentHost() {
      state.started = false;
      setCursorActive(false);
      state.window?.destroy?.();
      state.window = null;
      state.browserPresentations.clear();
      state.computerUsePresentations.clear();
      return true;
    },

    setRemoteHostedPIPContentActiveThreadID(threadId) {
      if (threadId != null && typeof threadId !== "string") return false;
      state.activeThreadId = threadId;
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
      state.computerUsePresentations.delete(threadId);
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
      state.computerUsePresentations.delete(threadId);
      reconcile();
      return true;
    },

    upsertComputerUsePIPContent(threadId, imageDataUrl, appId = null) {
      if (
        typeof threadId !== "string" || threadId.trim() === "" ||
        !validImageDataUrl(imageDataUrl) ||
        appId != null && typeof appId !== "string"
      ) {
        return false;
      }
      state.computerUsePresentations.set(threadId, {
        id: `computer-use:${threadId}`,
        imageDataUrl,
        kind: "computer-use",
        threadId,
        title: appId?.trim() ? `Computer Use — ${appId.trim()}` : "Computer Use",
      });
      reconcile();
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
    const { BrowserWindow, screen } = require("electron");
    defaultHost = createPictureInPictureHost({ BrowserWindow, screen });
  }
  return defaultHost;
}

function computerUsePresentationFromNotification(notification) {
  if (
    notification?.method !== "item/completed" ||
    typeof notification.params?.threadId !== "string" ||
    notification.params.threadId.trim() === ""
  ) {
    return null;
  }
  const item = notification.params.item;
  if (item?.type !== "mcpToolCall" || item.server !== "node_repl") return null;
  const surface = item.result?._meta?.["codex/toolSurface"];
  if (surface?.kind !== "computerUse" || !validImageDataUrl(surface.screenshot?.url)) return null;
  const appId = surface.app?.kind === "appId" && typeof surface.app.appId === "string"
    ? surface.app.appId
    : null;
  return {
    appId,
    imageDataUrl: surface.screenshot.url,
    threadId: notification.params.threadId,
  };
}

function subscribeComputerUsePIPMetadata(appServerConnection) {
  if (typeof appServerConnection?.registerInternalNotificationHandler !== "function") {
    throw new TypeError("Computer Use PiP requires an app-server notification connection");
  }
  return appServerConnection.registerInternalNotificationHandler(notification => {
    const presentation = computerUsePresentationFromNotification(notification);
    if (!presentation) return;
    getDefaultHost().upsertComputerUsePIPContent(
      presentation.threadId,
      presentation.imageDataUrl,
      presentation.appId,
    );
  });
}

const nativeMethods = [
  "startRemoteHostedPIPContentHost",
  "connectRemoteHostedPIPContentHost",
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
  computerUsePresentationFromNotification,
  createPictureInPictureHost,
  enableLinuxPictureInPicture,
  subscribeComputerUsePIPMetadata,
};
for (const method of nativeMethods) {
  module.exports[method] = (...arguments_) => getDefaultHost()[method](...arguments_);
}
