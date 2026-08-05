const DICTATION_SUPPORT_GUARD =
  "function W7(){return process.platform===`darwin`||process.platform===`win32`}";
const DICTATION_SUPPORT_LINUX =
  "function W7(){return process.platform===`darwin`||process.platform===`win32`||process.platform===`linux`}";

const SHORTCUT_REGISTRATION_GUARD = "function uN(e,t,n){if(JM(e))";
const SHORTCUT_REGISTRATION_LINUX =
  "function uN(e,t,n){if(process.platform===`linux`&&process.env.XDG_SESSION_TYPE===`wayland`){let r=(0,x.spawn)((0,p.join)(process.resourcesPath,`linux-runtime`,`bin`,`chatgpt-linux-desktop-bridge`),[`watch-hotkey`,e],{stdio:[`ignore`,`pipe`,`ignore`]}),i=!1;return nN(r,e=>{e===`down`?t.onPressed():e===`up`&&t.onReleased?.()}),r.once(`error`,e=>{i||cN().warning(`Wayland global dictation hotkey failed`,{safe:{},sensitive:{error:e}})}),r.once(`exit`,e=>{i||(e===0||cN().warning(`Wayland global dictation hotkey exited`,{safe:{exitCode:e},sensitive:{}}),t.onReleased?.())}),{handlesRelease:!0,unregister:()=>{i=!0,r.kill()}}}if(JM(e))";

const SHORTCUT_VALIDATION_GUARD =
  "function AN(e,t){return t===`darwin`?wN(e).length>0:EN(e,t)!=null}";
const SHORTCUT_VALIDATION_LINUX =
  "function AN(e,t){return t===`darwin`?wN(e).length>0:t===`linux`?hN(e).length>0:EN(e,t)!=null}";

const RELEASE_GUARD =
  "case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`linux`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`)}}function wN";
const RELEASE_LINUX =
  "case`aix`:case`android`:case`cygwin`:case`freebsd`:case`haiku`:case`netbsd`:case`openbsd`:case`sunos`:throw Error(`Global dictation hotkey release watching is not supported.`);case`linux`:return DN((0,x.spawn)((0,p.join)(process.resourcesPath,`linux-runtime`,`bin`,`chatgpt-linux-desktop-bridge`),[`wait-hotkey-release`,e],{stdio:`ignore`}),t)}}function wN";

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
