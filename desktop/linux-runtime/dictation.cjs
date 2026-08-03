const DICTATION_SUPPORT_GUARD =
  "function W7(){return process.platform===`darwin`||process.platform===`win32`}";
const DICTATION_SUPPORT_LINUX =
  "function W7(){return process.platform===`darwin`||process.platform===`win32`||process.platform===`linux`}";

const SHORTCUT_REGISTRATION_GUARD = "function nN(e,t,n){if(BM(e))";
const SHORTCUT_REGISTRATION_LINUX =
  "function nN(e,t,n){if(process.platform===`linux`&&process.env.XDG_SESSION_TYPE===`wayland`){let r=(0,x.spawn)((0,p.join)(process.resourcesPath,`linux-runtime`,`bin`,`chatgpt-linux-desktop-bridge`),[`watch-hotkey`,e],{stdio:[`ignore`,`pipe`,`ignore`]}),i=!1;return JM(r,e=>{e===`down`?t.onPressed():e===`up`&&t.onReleased?.()}),r.once(`error`,e=>{i||eN().warning(`Wayland global dictation hotkey failed`,{safe:{},sensitive:{error:e}})}),r.once(`exit`,e=>{i||(e===0||eN().warning(`Wayland global dictation hotkey exited`,{safe:{exitCode:e},sensitive:{}}),t.onReleased?.())}),{handlesRelease:!0,unregister:()=>{i=!0,r.kill()}}}if(BM(e))";

const SHORTCUT_VALIDATION_GUARD =
  "function SN(e,t){return t===`darwin`?gN(e).length>0:vN(e,t)!=null}";
const SHORTCUT_VALIDATION_LINUX =
  "function SN(e,t){return t===`darwin`?gN(e).length>0:t===`linux`?sN(e).length>0:vN(e,t)!=null}";

const RELEASE_GUARD =
  "case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`)}}function gN";
const RELEASE_LINUX =
  "case`haiku`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`);case`linux`:return yN((0,x.spawn)((0,p.join)(process.resourcesPath,`linux-runtime`,`bin`,`chatgpt-linux-desktop-bridge`),[`wait-hotkey-release`,e],{stdio:`ignore`}),t)}}function gN";

const PASTE_GUARD =
  "case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation paste is not supported on this OS.`)}}var B7";
const PASTE_LINUX =
  "case`haiku`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation paste is not supported on this OS.`);case`linux`:process.env.XDG_SESSION_TYPE===`wayland`?await z7((0,p.join)(process.resourcesPath,`linux-runtime`,`bin`,`chatgpt-linux-desktop-bridge`),[`paste`]):await z7((0,p.join)(process.resourcesPath,`cua_node`,`bin`,`node`),[(0,p.join)(process.resourcesPath,`linux-runtime`,`linux-input.mjs`),`paste`]);return}}var B7";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first === -1 || source.indexOf(before, first + before.length) !== -1) {
    throw new Error(`Expected exactly one upstream ${label} boundary`);
  }
  return source.replace(before, after);
}

function enableLinuxDictation(source) {
  let patched = replaceExactlyOnce(source, DICTATION_SUPPORT_GUARD, DICTATION_SUPPORT_LINUX, "dictation support");
  patched = replaceExactlyOnce(patched, SHORTCUT_REGISTRATION_GUARD, SHORTCUT_REGISTRATION_LINUX, "dictation shortcut registration");
  patched = replaceExactlyOnce(patched, SHORTCUT_VALIDATION_GUARD, SHORTCUT_VALIDATION_LINUX, "dictation shortcut validation");
  patched = replaceExactlyOnce(patched, RELEASE_GUARD, RELEASE_LINUX, "dictation release watcher");
  return replaceExactlyOnce(patched, PASTE_GUARD, PASTE_LINUX, "dictation paste");
}

module.exports = { enableLinuxDictation };
