import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const pictureInPicture = require("../desktop/linux-runtime/picture-in-picture.cjs");

const png = `data:image/png;base64,${Buffer.from("browser-preview").toString("base64")}`;
const jpeg = `data:image/jpeg;base64,${Buffer.from("desktop-preview").toString("base64")}`;

class FakeWebContents extends EventEmitter {}

class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = [];
  options: Record<string, unknown>;
  webContents = new FakeWebContents();
  bounds = { x: 0, y: 0, width: 420, height: 286 };
  destroyed = false;
  visible = false;
  urls: string[] = [];

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    FakeBrowserWindow.instances.push(this);
  }

  destroy() { this.destroyed = true; this.emit("closed"); }
  getBounds() { return { ...this.bounds }; }
  hide() { this.visible = false; }
  isDestroyed() { return this.destroyed; }
  async loadURL(url: string) { this.urls.push(url); }
  setAlwaysOnTop() {}
  setBounds(bounds: typeof this.bounds) { this.bounds = { ...bounds }; }
  setMenuBarVisibility() {}
  setVisibleOnAllWorkspaces() {}
  showInactive() { this.visible = true; }
}

const screen = {
  getCursorScreenPoint: () => ({ x: 71, y: 92 }),
  getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
  getPrimaryDisplay: () => ({ id: 7, workArea: { x: 0, y: 0, width: 1280, height: 800 } }),
};

function decodedPage(window: FakeBrowserWindow) {
  const url = window.urls.at(-1) ?? "";
  return decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length));
}

function host(overrides: Record<string, unknown> = {}) {
  FakeBrowserWindow.instances = [];
  return pictureInPicture.createPictureInPictureHost({
    BrowserWindow: FakeBrowserWindow,
    screen,
    ...overrides,
  });
}

test("Linux PiP renders Browser Use screenshots and emits native visibility actions", () => {
  const pip = host();
  const visibility: unknown[] = [];
  assert.equal(pip.startRemoteHostedPIPContentHost({ hide: "Hide this", placement: "Send to pet" }), true);
  assert.equal(pip.setRemoteHostedPIPContentVisibilityRequestHandler((...value: unknown[]) => visibility.push(value)), true);
  assert.equal(pip.setRemoteHostedPIPContentActiveThreadID("thread-browser"), true);
  assert.equal(pip.registerRemoteHostedPIPContentHost({
    anchorRect: { x: 30, y: 40, width: 20, height: 20 },
    browserWindowId: 5,
    contentBounds: { x: 100, y: 100, width: 900, height: 700 },
    id: "main",
    title: "ChatGPT",
  }), true);
  assert.equal(pip.upsertBrowserUsePIPContent("browser:one", "thread-browser", png, null), true);

  const window = FakeBrowserWindow.instances[0];
  assert.ok(window.visible);
  assert.match(decodedPage(window), /Browser Use/);
  assert.match(decodedPage(window), /data:image\/png;base64/);
  assert.match(decodedPage(window), /Content-Security-Policy/);
  assert.deepEqual(window.options.webPreferences, {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  });
  assert.equal(pip.hasRemoteHostedPIPContentActivePresentation(), true);
  assert.equal(pip.hasRemoteHostedPIPContentAnyPresentation(), true);

  let prevented = false;
  window.webContents.emit("will-navigate", { preventDefault: () => { prevented = true; } }, "chatgpt-pip-action://hide");
  assert.equal(prevented, true);
  assert.deepEqual(visibility, [[false, ["thread-browser"]]]);
  assert.equal(window.visible, false);
  assert.equal(pip.hasRemoteHostedPIPContentActivePresentation(), false);
});

test("opening and focusing an ordinary chat creates no PiP, pet wake, or capture window", () => {
  const petWakes: unknown[] = [];
  const pip = host();
  assert.equal(pip.startRemoteHostedPIPContentHost(), true);
  assert.equal(pip.setRemoteHostedPIPContentPetWakeRequestHandler((...value: unknown[]) => petWakes.push(value)), true);
  assert.equal(pip.setRemoteHostedPIPContentActiveThreadID("thread-ordinary"), true);
  assert.equal(pip.registerRemoteHostedPIPContentHost({
    anchorRect: { x: 30, y: 40, width: 20, height: 20 },
    browserWindowId: 5,
    contentBounds: { x: 100, y: 100, width: 900, height: 700 },
    id: "main",
    title: "ChatGPT",
  }), true);

  assert.equal(FakeBrowserWindow.instances.length, 0);
  assert.deepEqual(petWakes, []);
  assert.equal(pip.hasRemoteHostedPIPContentActivePresentation(), false);
  assert.equal(pip.hasRemoteHostedPIPContentAnyPresentation(), false);
});

test("real Computer Use metadata opens PiP and forwards cursor and resize events", () => {
  const cursors: unknown[] = [];
  const sizes: number[] = [];
  const pip = host();
  pip.startRemoteHostedPIPContentHost();
  pip.setRemoteHostedPIPContentComputerUseCursorLocationHandler((value: unknown) => cursors.push(value));
  pip.setRemoteHostedPIPContentMaxDisplaySizeChangedHandler((value: number) => sizes.push(value));
  assert.equal(pip.setRemoteHostedPIPContentActiveThreadID("thread-computer"), true);
  assert.equal(pip.upsertComputerUsePIPContent("thread-computer", jpeg, "org.test.Editor"), true);

  const window = FakeBrowserWindow.instances[0];
  assert.ok(window.visible);
  assert.match(decodedPage(window), /Computer Use — org\.test\.Editor/);
  assert.match(decodedPage(window), /data:image\/jpeg;base64/);
  assert.deepEqual(cursors.at(-1), { isActive: true, x: 71, y: 92 });
  assert.equal(pip.hasRemoteHostedPIPContentActivePresentation(), true);

  window.bounds = { ...window.bounds, width: 510, height: 320 };
  window.emit("resize");
  assert.deepEqual(sizes, [510]);
  assert.equal(pip.invalidateRemoteHostedPIPContentTurn("thread-computer", "turn-1"), true);
  assert.equal(pip.completeRemoteHostedPIPContentThread("thread-computer"), true);
  assert.equal(pip.hasRemoteHostedPIPContentAnyPresentation(), false);
  assert.equal(window.visible, false);
  assert.deepEqual(cursors.at(-1), { isActive: false, x: 71, y: 92 });
});

test("only completed node_repl Computer Use calls with screenshots become PiP presentations", () => {
  const notification = {
    method: "item/completed",
    params: {
      threadId: "thread-computer",
      item: {
        type: "mcpToolCall",
        server: "node_repl",
        result: {
          _meta: {
            "codex/toolSurface": {
              kind: "computerUse",
              app: { kind: "appId", appId: "org.test.Editor" },
              screenshot: { url: jpeg },
            },
          },
        },
      },
    },
  };
  assert.deepEqual(pictureInPicture.computerUsePresentationFromNotification(notification), {
    appId: "org.test.Editor",
    imageDataUrl: jpeg,
    threadId: "thread-computer",
  });
  assert.equal(pictureInPicture.computerUsePresentationFromNotification({
    ...notification,
    params: { ...notification.params, item: { ...notification.params.item, server: "other" } },
  }), null);
  assert.equal(pictureInPicture.computerUsePresentationFromNotification({
    ...notification,
    params: {
      ...notification.params,
      item: {
        ...notification.params.item,
        result: { _meta: { "codex/toolSurface": { kind: "computerUse" } } },
      },
    },
  }), null);
});

test("the pinned Sky contract is opened only for Linux and remains assertion checked", () => {
  const loader = "function go({electronAppPath:e,resourcesPath:t}){let n=";
  const guards = Array.from({ length: 19 }, () => "if(r!==`darwin`)return!1;").join("");
  const wrappers = `function Lo({addon:e,controlTooltips:t,${guards}return{contentBounds:t.getContentBounds(),id:e,nativeWindowHandle:typeof t.getNativeWindowHandle==\`function\`?t.getNativeWindowHandle():null}}function filler(){}var ns=n.nl({`;
  const manager = "isEnabled:oe,isMacOS:M,nativeIntl:";
  const subscription = "F.add(as({appServerConnection:Ae(),isEnabled:oe})),F.add(wre({appServerConnection:Ae(),closeActiveTurn:ze.closeActiveTurn}));";
  const patched = pictureInPicture.enableLinuxPictureInPicture(`${loader}${wrappers}${manager}${subscription}`);

  assert.match(patched, /linux-runtime.*picture-in-picture\.cjs/);
  assert.match(patched, /r!==`darwin`&&r!==`linux`/);
  assert.match(patched, /browserWindowId:t\.id/);
  assert.match(patched, /isMacOS:M\|\|process\.platform===`linux`/);
  assert.match(patched, /subscribeComputerUsePIPMetadata/);
  assert.throws(
    () => pictureInPicture.enableLinuxPictureInPicture(`${loader}${wrappers.replace(guards, guards.slice(0, -"if(r!==`darwin`)return!1;".length))}${manager}${subscription}`),
    /Expected 19/,
  );
  assert.throws(() => pictureInPicture.enableLinuxPictureInPicture("missing"), /exactly one/);
});

test("the Linux provider exports the complete 19-method upstream native surface", () => {
  const methods = [
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
  for (const method of methods) assert.equal(typeof pictureInPicture[method], "function", method);
});
