use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
    process::ExitCode,
    thread,
    time::Duration,
};

use ashpd::desktop::{
    PersistMode,
    global_shortcuts::{BindShortcutsOptions, GlobalShortcuts, NewShortcut},
    remote_desktop::{
        DeviceType, KeyState, NotifyKeyboardKeysymOptions, RemoteDesktop,
        SelectDevicesOptions,
    },
    CreateSessionOptions,
};
use futures_util::{FutureExt, StreamExt, pin_mut};
use x11rb::protocol::xproto::ConnectionExt;

const CONTROL_MODIFIER: usize = 2;
const ALT_MODIFIER: usize = 3;
const LOGO_MODIFIER: usize = 6;
const SHIFT_MODIFIER: usize = 0;
const XKB_CONTROL_L: i32 = 0xffe3;
const XKB_V: i32 = 0x0076;

#[cfg(test)]
fn pressed_key_count(keymap: &[u8; 32]) -> u32 {
    keymap.iter().map(|byte| byte.count_ones()).sum()
}

fn modifier_indices(accelerator: &str) -> Result<Vec<usize>, String> {
    let mut modifiers = Vec::new();
    for component in accelerator.split('+').map(str::trim).filter(|part| !part.is_empty()) {
        let modifier = match component.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "control" | "ctrl" => Some(CONTROL_MODIFIER),
            "alt" | "option" => Some(ALT_MODIFIER),
            "command" | "cmd" | "logo" | "meta" | "super" => Some(LOGO_MODIFIER),
            "shift" => Some(SHIFT_MODIFIER),
            _ => None,
        };
        if let Some(modifier) = modifier {
            if !modifiers.contains(&modifier) {
                modifiers.push(modifier);
            }
        }
    }
    if modifiers.is_empty() {
        Err("global dictation hotkey has no supported modifier".into())
    } else {
        Ok(modifiers)
    }
}

fn key_is_pressed(keymap: &[u8; 32], keycode: u8) -> bool {
    let byte = usize::from(keycode / 8);
    let bit = keycode % 8;
    keymap[byte] & (1 << bit) != 0
}

fn modifier_is_pressed(
    keymap: &[u8; 32],
    modifier_keycodes: &[u8],
    keycodes_per_modifier: usize,
    modifier: usize,
) -> bool {
    let start = modifier * keycodes_per_modifier;
    modifier_keycodes
        .get(start..start + keycodes_per_modifier)
        .is_some_and(|keycodes| {
            keycodes
                .iter()
                .copied()
                .filter(|keycode| *keycode != 0)
                .any(|keycode| key_is_pressed(keymap, keycode))
        })
}

fn wait_hotkey_release(accelerator: &str) -> Result<(), Box<dyn std::error::Error>> {
    let required_modifiers = modifier_indices(accelerator).map_err(io::Error::other)?;
    let (connection, _) = x11rb::connect(None)?;
    let modifier_map = connection.get_modifier_mapping()?.reply()?;
    let keycodes_per_modifier = modifier_map.keycodes.len() / 8;

    loop {
        let reply = connection.query_keymap()?.reply()?;
        if required_modifiers.iter().copied().any(|modifier| {
            !modifier_is_pressed(
                &reply.keys,
                &modifier_map.keycodes,
                keycodes_per_modifier,
                modifier,
            )
        }) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn xdg_shortcut(accelerator: &str) -> Result<String, String> {
    let mut modifiers = Vec::new();
    let mut key = None;
    for component in accelerator.split('+').map(str::trim).filter(|part| !part.is_empty()) {
        let normalized = match component.to_ascii_lowercase().as_str() {
            "cmdorctrl" | "control" | "ctrl" => Some("CTRL"),
            "alt" | "option" => Some("ALT"),
            "command" | "cmd" | "logo" | "meta" | "super" => Some("LOGO"),
            "shift" => Some("SHIFT"),
            "num" => Some("NUM"),
            _ => None,
        };
        if let Some(modifier) = normalized {
            if !modifiers.contains(&modifier) {
                modifiers.push(modifier);
            }
            continue;
        }
        if key.is_some() {
            return Err("global shortcut must contain exactly one non-modifier key".into());
        }
        key = Some(xkb_key_name(component)?);
    }

    let key = key.ok_or_else(|| "global shortcut must contain a non-modifier key".to_string())?;
    if modifiers.is_empty() {
        return Err("global shortcut must contain a supported modifier".into());
    }
    modifiers.push(&key);
    Ok(modifiers.join("+"))
}

fn xkb_key_name(key: &str) -> Result<String, String> {
    let known = match key.to_ascii_lowercase().as_str() {
        "space" => Some("space"),
        "enter" | "return" => Some("Return"),
        "escape" | "esc" => Some("Escape"),
        "tab" => Some("Tab"),
        "backspace" => Some("BackSpace"),
        "delete" => Some("Delete"),
        "insert" => Some("Insert"),
        "home" => Some("Home"),
        "end" => Some("End"),
        "pageup" => Some("Prior"),
        "pagedown" => Some("Next"),
        "left" => Some("Left"),
        "right" => Some("Right"),
        "up" => Some("Up"),
        "down" => Some("Down"),
        _ => None,
    };
    if let Some(known) = known {
        return Ok(known.into());
    }
    if key.len() == 1 && key.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return Ok(key.to_ascii_lowercase());
    }
    if key
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    {
        return Ok(key.into());
    }
    Err("global shortcut key is not an XKB key identifier".into())
}

fn emit_hotkey_event(event: &str) -> io::Result<()> {
    println!("{event}");
    io::stdout().flush()
}

async fn watch_hotkey(accelerator: &str) -> Result<(), Box<dyn std::error::Error>> {
    let preferred_trigger = xdg_shortcut(accelerator).map_err(io::Error::other)?;
    let portal = GlobalShortcuts::new().await?;
    let activated = portal.receive_activated().await?;
    let deactivated = portal.receive_deactivated().await?;
    pin_mut!(activated, deactivated);

    let session = portal.create_session(CreateSessionOptions::default()).await?;
    let request = portal
        .bind_shortcuts(
            &session,
            &[NewShortcut::new("global-dictation", "ChatGPT global dictation")
                .preferred_trigger(Some(preferred_trigger.as_str()))],
            None,
            BindShortcutsOptions::default(),
        )
        .await?;
    let response = request.response()?;
    if !response
        .shortcuts()
        .iter()
        .any(|shortcut| shortcut.id() == "global-dictation")
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the desktop did not bind the global dictation shortcut",
        )
        .into());
    }
    emit_hotkey_event("ready")?;

    loop {
        let activation = activated.next().fuse();
        let deactivation = deactivated.next().fuse();
        pin_mut!(activation, deactivation);
        futures_util::select! {
            event = activation => match event {
                Some(event) if event.shortcut_id() == "global-dictation" => emit_hotkey_event("down")?,
                Some(_) => {},
                None => return Err(io::Error::new(io::ErrorKind::BrokenPipe, "global-shortcuts activation stream closed").into()),
            },
            event = deactivation => match event {
                Some(event) if event.shortcut_id() == "global-dictation" => emit_hotkey_event("up")?,
                Some(_) => {},
                None => return Err(io::Error::new(io::ErrorKind::BrokenPipe, "global-shortcuts deactivation stream closed").into()),
            },
        }
    }
}

fn portal_token_path() -> Option<PathBuf> {
    let root = env::var_os("CODEX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("XDG_STATE_HOME")
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join("chatgpt"))
        })
        .or_else(|| {
            env::var_os("HOME")
                .filter(|value| !value.is_empty())
                .map(|value| PathBuf::from(value).join(".local/state/chatgpt"))
        })?;
    Some(root.join("linux-portals/remote-desktop-restore-token"))
}

fn read_portal_token() -> Option<String> {
    let token = fs::read_to_string(portal_token_path()?).ok()?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

fn write_portal_token(token: &str) -> io::Result<()> {
    let target = portal_token_path().ok_or_else(|| {
        io::Error::new(io::ErrorKind::NotFound, "no state directory for portal restore token")
    })?;
    let directory = target.parent().ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "portal restore token path has no parent")
    })?;
    fs::create_dir_all(directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
    let temporary = target.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(token.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(temporary, target)
}

async fn portal_paste() -> Result<(), Box<dyn std::error::Error>> {
    let portal = RemoteDesktop::new().await?;
    let session = portal.create_session(CreateSessionOptions::default()).await?;
    let restore_token = read_portal_token();
    let mut options = SelectDevicesOptions::default()
        .set_devices(Some(DeviceType::Keyboard.into()))
        .set_persist_mode(PersistMode::ExplicitlyRevoked);
    if let Some(token) = restore_token.as_deref() {
        options = options.set_restore_token(Some(token));
    }
    portal.select_devices(&session, options).await?.response()?;
    let selected = portal.start(&session, None, Default::default()).await?.response()?;
    if !selected.devices().contains(DeviceType::Keyboard) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "the desktop did not authorize keyboard input",
        )
        .into());
    }
    if let Some(token) = selected.restore_token() {
        write_portal_token(token)?;
    }

    portal
        .notify_keyboard_keysym(
            &session,
            XKB_CONTROL_L,
            KeyState::Pressed,
            NotifyKeyboardKeysymOptions::default(),
        )
        .await?;
    if let Err(error) = portal
        .notify_keyboard_keysym(
            &session,
            XKB_V,
            KeyState::Pressed,
            NotifyKeyboardKeysymOptions::default(),
        )
        .await
    {
        let _ = portal
            .notify_keyboard_keysym(
                &session,
                XKB_CONTROL_L,
                KeyState::Released,
                NotifyKeyboardKeysymOptions::default(),
            )
            .await;
        return Err(error.into());
    }
    let release_v = portal
        .notify_keyboard_keysym(
            &session,
            XKB_V,
            KeyState::Released,
            NotifyKeyboardKeysymOptions::default(),
        )
        .await;
    let release_control = portal
        .notify_keyboard_keysym(
            &session,
            XKB_CONTROL_L,
            KeyState::Released,
            NotifyKeyboardKeysymOptions::default(),
        )
        .await;
    release_v?;
    release_control?;
    Ok(())
}

async fn async_main() -> ExitCode {
    let mut arguments = env::args().skip(1);
    let command = arguments.next();
    let result = match command.as_deref() {
        Some("wait-hotkey-release") => {
            let accelerator = arguments.next().ok_or("wait-hotkey-release requires an accelerator");
            match accelerator {
                Ok(accelerator) => wait_hotkey_release(&accelerator),
                Err(error) => Err(error.into()),
            }
        }
        Some("watch-hotkey") => {
            let accelerator = arguments.next().ok_or("watch-hotkey requires an accelerator");
            match accelerator {
                Ok(accelerator) => watch_hotkey(&accelerator).await,
                Err(error) => Err(error.into()),
            }
        }
        Some("paste") => portal_paste().await,
        _ => Err("usage: chatgpt-linux-desktop-bridge <wait-hotkey-release ACCELERATOR|watch-hotkey ACCELERATOR|paste>".into()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    }
}

fn main() -> ExitCode {
    match tokio::runtime::Builder::new_current_thread().build() {
        Ok(runtime) => runtime.block_on(async_main()),
        Err(error) => {
            eprintln!("failed to start Linux desktop bridge runtime: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CONTROL_MODIFIER, modifier_indices, modifier_is_pressed, pressed_key_count, xdg_shortcut,
    };

    #[test]
    fn counts_pressed_bits() {
        let mut keymap = [0_u8; 32];
        keymap[4] = 0b1000_0001;
        keymap[8] = 0b0000_0010;
        assert_eq!(pressed_key_count(&keymap), 3);
    }

    #[test]
    fn tracks_only_required_x11_modifiers() {
        assert_eq!(modifier_indices("Ctrl+Shift+D").unwrap(), vec![2, 0]);
        let mut keymap = [0_u8; 32];
        keymap[4] = 0b0010_0000; // keycode 37, commonly Control_L
        let mut modifier_map = vec![0_u8; 16];
        modifier_map[CONTROL_MODIFIER * 2] = 37;
        assert!(modifier_is_pressed(
            &keymap,
            &modifier_map,
            2,
            CONTROL_MODIFIER
        ));
    }

    #[test]
    fn converts_electron_accelerators_to_xdg_shortcuts() {
        assert_eq!(xdg_shortcut("CmdOrCtrl+Shift+D").unwrap(), "CTRL+SHIFT+d");
        assert_eq!(xdg_shortcut("Alt+Space").unwrap(), "ALT+space");
        assert!(xdg_shortcut("Ctrl+D+E").is_err());
        assert!(xdg_shortcut("D").is_err());
    }
}
