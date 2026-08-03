//! Active XDG RemoteDesktop and Screenshot portal adapters for Wayland.

use std::{
    env,
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::PathBuf,
};

use ashpd::desktop::{
    CreateSessionOptions, PersistMode, Session,
    remote_desktop::{
        DeviceType, KeyState, NotifyKeyboardKeysymOptions,
        NotifyPointerAxisOptions, NotifyPointerButtonOptions,
        NotifyPointerMotionAbsoluteOptions, RemoteDesktop, SelectDevicesOptions,
    },
    screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType, Stream},
    screenshot::Screenshot as PortalScreenshot,
};
use thiserror::Error;

use crate::{
    coordinates::LogicalRect,
    protocol::{ActionRequest, MouseButton, ScrollDirection},
};

const BTN_LEFT: i32 = 0x110;
const BTN_RIGHT: i32 = 0x111;
const BTN_MIDDLE: i32 = 0x112;
const DEFAULT_SCROLL_PAGE_PIXELS: f64 = 800.0;

#[derive(Debug, Clone, Copy)]
struct StreamGeometry {
    node_id: u32,
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
}

#[derive(Debug)]
pub struct PortalControl {
    remote: RemoteDesktop,
    session: Session<RemoteDesktop>,
    streams: Vec<Stream>,
    pointer: bool,
    keyboard: bool,
}

impl PortalControl {
    /// Create one persistent RemoteDesktop session. The compositor owns the
    /// permission prompt and may restore a previously approved session.
    pub async fn connect() -> Result<Self, PortalControlError> {
        let remote = RemoteDesktop::new().await.map_err(portal_error)?;
        let screencast = Screencast::new().await.map_err(portal_error)?;
        let session = remote
            .create_session(CreateSessionOptions::default())
            .await
            .map_err(portal_error)?;
        let restore_token = read_restore_token();

        let mut devices = SelectDevicesOptions::default()
            .set_devices(DeviceType::Keyboard | DeviceType::Pointer)
            .set_persist_mode(PersistMode::ExplicitlyRevoked);
        let mut sources = SelectSourcesOptions::default()
            .set_sources(Some(SourceType::Monitor.into()))
            .set_multiple(true)
            .set_cursor_mode(CursorMode::Embedded)
            .set_persist_mode(PersistMode::ExplicitlyRevoked);
        if let Some(token) = restore_token.as_deref() {
            devices = devices.set_restore_token(Some(token));
            sources = sources.set_restore_token(Some(token));
        }

        remote
            .select_devices(&session, devices)
            .await
            .map_err(portal_error)?
            .response()
            .map_err(portal_error)?;
        screencast
            .select_sources(&session, sources)
            .await
            .map_err(portal_error)?
            .response()
            .map_err(portal_error)?;
        let selected = remote
            .start(&session, None, Default::default())
            .await
            .map_err(portal_error)?
            .response()
            .map_err(portal_error)?;
        if let Some(token) = selected.restore_token() {
            let _ = write_restore_token(token);
        }
        let pointer = selected.devices().contains(DeviceType::Pointer);
        let keyboard = selected.devices().contains(DeviceType::Keyboard);
        if !pointer && !keyboard {
            return Err(PortalControlError::Permission(
                "the compositor authorized neither pointer nor keyboard control".into(),
            ));
        }
        Ok(Self {
            remote,
            session,
            streams: selected.streams().to_vec(),
            pointer,
            keyboard,
        })
    }

    #[must_use]
    pub fn pointer_active(&self) -> bool {
        self.pointer
    }

    #[must_use]
    pub fn keyboard_active(&self) -> bool {
        self.keyboard
    }

    pub async fn perform_action(
        &self,
        request: &ActionRequest,
        target_bounds: Option<LogicalRect>,
    ) -> Result<(), PortalControlError> {
        match request {
            ActionRequest::Click {
                x,
                y,
                mouse_button,
                click_count,
                ..
            } => {
                self.require_pointer()?;
                let (x, y) = match (*x, *y, target_bounds) {
                    (Some(x), Some(y), _) => (x, y),
                    (None, None, Some(bounds)) => bounds_center(bounds),
                    _ => return Err(PortalControlError::MissingBounds),
                };
                self.move_pointer(x, y).await?;
                let button = portal_button(mouse_button.unwrap_or(MouseButton::Left));
                for _ in 0..click_count.unwrap_or(1) {
                    self.pointer_button(button, KeyState::Pressed).await?;
                    self.pointer_button(button, KeyState::Released).await?;
                }
                Ok(())
            }
            ActionRequest::Drag {
                from_x,
                from_y,
                to_x,
                to_y,
                ..
            } => {
                self.require_pointer()?;
                self.move_pointer(*from_x, *from_y).await?;
                self.pointer_button(BTN_LEFT, KeyState::Pressed).await?;
                if let Err(error) = self.move_pointer(*to_x, *to_y).await {
                    let _ = self.pointer_button(BTN_LEFT, KeyState::Released).await;
                    return Err(error);
                }
                self.pointer_button(BTN_LEFT, KeyState::Released).await
            }
            ActionRequest::PressKey { key, .. } => {
                self.require_keyboard()?;
                self.press_keysyms(&parse_key_chord(key)?).await
            }
            ActionRequest::TypeText { text, .. } => {
                self.require_keyboard()?;
                for character in text.chars() {
                    let keysym = character_keysym(character);
                    self.press_keysyms(&[keysym]).await?;
                }
                Ok(())
            }
            ActionRequest::Scroll {
                direction, pages, ..
            } => {
                self.require_pointer()?;
                let bounds = target_bounds.ok_or(PortalControlError::MissingBounds)?;
                let (x, y) = bounds_center(bounds);
                self.move_pointer(x, y).await?;
                let distance = pages.unwrap_or(1.0) * DEFAULT_SCROLL_PAGE_PIXELS;
                let (dx, dy) = match direction {
                    ScrollDirection::Up => (0.0, -distance),
                    ScrollDirection::Down => (0.0, distance),
                    ScrollDirection::Left => (-distance, 0.0),
                    ScrollDirection::Right => (distance, 0.0),
                };
                self.remote
                    .notify_pointer_axis(
                        &self.session,
                        dx,
                        dy,
                        NotifyPointerAxisOptions::default().set_finish(true),
                    )
                    .await
                    .map_err(portal_error)
            }
            ActionRequest::SetValue { .. }
            | ActionRequest::PerformSecondaryAction { .. }
            | ActionRequest::SelectText { .. } => Err(PortalControlError::SemanticOnly),
        }
    }

    fn require_pointer(&self) -> Result<(), PortalControlError> {
        if self.pointer {
            Ok(())
        } else {
            Err(PortalControlError::Permission(
                "the compositor did not authorize pointer control".into(),
            ))
        }
    }

    fn require_keyboard(&self) -> Result<(), PortalControlError> {
        if self.keyboard {
            Ok(())
        } else {
            Err(PortalControlError::Permission(
                "the compositor did not authorize keyboard control".into(),
            ))
        }
    }

    async fn move_pointer(&self, x: f64, y: f64) -> Result<(), PortalControlError> {
        let geometries: Vec<_> = self
            .streams
            .iter()
            .map(|stream| StreamGeometry {
                node_id: stream.pipe_wire_node_id(),
                position: stream.position(),
                size: stream.size(),
            })
            .collect();
        let (stream, local_x, local_y) = map_stream_point(&geometries, x, y)?;
        self.remote
            .notify_pointer_motion_absolute(
                &self.session,
                stream,
                local_x,
                local_y,
                NotifyPointerMotionAbsoluteOptions::default(),
            )
            .await
            .map_err(portal_error)
    }

    async fn pointer_button(
        &self,
        button: i32,
        state: KeyState,
    ) -> Result<(), PortalControlError> {
        self.remote
            .notify_pointer_button(
                &self.session,
                button,
                state,
                NotifyPointerButtonOptions::default(),
            )
            .await
            .map_err(portal_error)
    }

    async fn press_keysyms(&self, keysyms: &[i32]) -> Result<(), PortalControlError> {
        for (index, keysym) in keysyms.iter().enumerate() {
            if let Err(error) = self
                .remote
                .notify_keyboard_keysym(
                    &self.session,
                    *keysym,
                    KeyState::Pressed,
                    NotifyKeyboardKeysymOptions::default(),
                )
                .await
            {
                for pressed in keysyms[..index].iter().rev() {
                    let _ = self
                        .remote
                        .notify_keyboard_keysym(
                            &self.session,
                            *pressed,
                            KeyState::Released,
                            NotifyKeyboardKeysymOptions::default(),
                        )
                        .await;
                }
                return Err(portal_error(error));
            }
        }
        let mut release_error = None;
        for keysym in keysyms.iter().rev() {
            if let Err(error) = self.remote
                .notify_keyboard_keysym(
                    &self.session,
                    *keysym,
                    KeyState::Released,
                    NotifyKeyboardKeysymOptions::default(),
                )
                .await
            {
                release_error.get_or_insert_with(|| portal_error(error));
            }
        }
        release_error.map_or(Ok(()), Err)
    }
}

pub async fn screenshot_url() -> Result<String, PortalControlError> {
    let request = PortalScreenshot::request()
        .interactive(false)
        .send()
        .await
        .map_err(portal_error)?;
    Ok(request
        .response()
        .map_err(portal_error)?
        .uri()
        .as_str()
        .to_owned())
}

fn bounds_center(bounds: LogicalRect) -> (f64, f64) {
    (bounds.x + bounds.width / 2.0, bounds.y + bounds.height / 2.0)
}

fn portal_button(button: MouseButton) -> i32 {
    match button {
        MouseButton::Left => BTN_LEFT,
        MouseButton::Right => BTN_RIGHT,
        MouseButton::Middle => BTN_MIDDLE,
    }
}

fn map_stream_point(
    streams: &[StreamGeometry],
    x: f64,
    y: f64,
) -> Result<(u32, f64, f64), PortalControlError> {
    for stream in streams {
        let (Some((origin_x, origin_y)), Some((width, height))) =
            (stream.position, stream.size)
        else {
            continue;
        };
        let origin_x = f64::from(origin_x);
        let origin_y = f64::from(origin_y);
        if x >= origin_x
            && y >= origin_y
            && x < origin_x + f64::from(width)
            && y < origin_y + f64::from(height)
        {
            return Ok((stream.node_id, x - origin_x, y - origin_y));
        }
    }
    if let [stream] = streams {
        if stream.position.is_none() || stream.size.is_none() {
            return Ok((stream.node_id, x, y));
        }
    }
    Err(PortalControlError::CoordinateOutsideStreams { x, y })
}

fn parse_key_chord(key: &str) -> Result<Vec<i32>, PortalControlError> {
    let parts: Vec<_> = key
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.is_empty() {
        return Err(PortalControlError::InvalidKey(key.into()));
    }
    parts.into_iter().map(named_keysym).collect()
}

fn named_keysym(key: &str) -> Result<i32, PortalControlError> {
    let symbol = match key.to_ascii_lowercase().as_str() {
        "ctrl" | "control" | "control_l" | "cmdorctrl" => 0xffe3,
        "control_r" => 0xffe4,
        "shift" | "shift_l" => 0xffe1,
        "shift_r" => 0xffe2,
        "alt" | "option" | "alt_l" => 0xffe9,
        "alt_r" => 0xffea,
        "super" | "meta" | "command" | "cmd" | "logo" | "super_l" => 0xffeb,
        "super_r" => 0xffec,
        "return" | "enter" => 0xff0d,
        "tab" => 0xff09,
        "escape" | "esc" => 0xff1b,
        "backspace" => 0xff08,
        "delete" => 0xffff,
        "insert" => 0xff63,
        "home" => 0xff50,
        "end" => 0xff57,
        "pageup" | "prior" | "pgup" => 0xff55,
        "pagedown" | "next" | "pgdn" => 0xff56,
        "left" => 0xff51,
        "up" => 0xff52,
        "right" => 0xff53,
        "down" => 0xff54,
        "space" | "spacebar" => 0x20,
        "pause" => 0xff13,
        "print" | "printscreen" => 0xff61,
        "menu" => 0xff67,
        "capslock" | "caps_lock" => 0xffe5,
        "numlock" | "num_lock" => 0xff7f,
        "scrolllock" | "scroll_lock" => 0xff14,
        "kp_0" => 0xffb0,
        "kp_1" => 0xffb1,
        "kp_2" => 0xffb2,
        "kp_3" => 0xffb3,
        "kp_4" => 0xffb4,
        "kp_5" => 0xffb5,
        "kp_6" => 0xffb6,
        "kp_7" => 0xffb7,
        "kp_8" => 0xffb8,
        "kp_9" => 0xffb9,
        "kp_enter" => 0xff8d,
        "kp_add" => 0xffab,
        "kp_subtract" => 0xffad,
        "kp_multiply" => 0xffaa,
        "kp_divide" => 0xffaf,
        "kp_decimal" => 0xffae,
        "plus" => 0x2b,
        "minus" => 0x2d,
        "equal" => 0x3d,
        "comma" => 0x2c,
        "period" => 0x2e,
        "slash" => 0x2f,
        "backslash" => 0x5c,
        "semicolon" => 0x3b,
        "apostrophe" | "quote" => 0x27,
        "bracketleft" => 0x5b,
        "bracketright" => 0x5d,
        "grave" | "quoteleft" => 0x60,
        "f1" => 0xffbe,
        "f2" => 0xffbf,
        "f3" => 0xffc0,
        "f4" => 0xffc1,
        "f5" => 0xffc2,
        "f6" => 0xffc3,
        "f7" => 0xffc4,
        "f8" => 0xffc5,
        "f9" => 0xffc6,
        "f10" => 0xffc7,
        "f11" => 0xffc8,
        "f12" => 0xffc9,
        _ => {
            let mut characters = key.chars();
            let Some(character) = characters.next() else {
                return Err(PortalControlError::InvalidKey(key.into()));
            };
            if characters.next().is_some() {
                return Err(PortalControlError::InvalidKey(key.into()));
            }
            return Ok(character_keysym(character));
        }
    };
    Ok(symbol)
}

fn character_keysym(character: char) -> i32 {
    // NotifyKeyboardKeysym consumes the resolved XKB symbol, not a physical
    // keycode. Keeping `A` as XK_A therefore preserves case without inventing
    // a keyboard-layout-dependent Shift chord. Non-Latin text uses the XKB
    // Unicode keysym encoding.
    match character {
        '\n' | '\r' => 0xff0d,
        '\t' => 0xff09,
        character if u32::from(character) <= 0xff => u32::from(character) as i32,
        character => (0x0100_0000 | u32::from(character)) as i32,
    }
}

fn restore_token_path() -> Option<PathBuf> {
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
    Some(root.join("linux-portals/computer-use-remote-desktop-restore-token"))
}

fn read_restore_token() -> Option<String> {
    let token = fs::read_to_string(restore_token_path()?).ok()?;
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_owned())
}

fn write_restore_token(token: &str) -> Result<(), PortalControlError> {
    let target = restore_token_path().ok_or_else(|| {
        PortalControlError::State("no state directory is available for the portal token".into())
    })?;
    let directory = target.parent().ok_or_else(|| {
        PortalControlError::State("portal restore token path has no parent".into())
    })?;
    fs::create_dir_all(directory).map_err(state_error)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(state_error)?;
    let temporary = target.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)
        .map_err(state_error)?;
    file.write_all(token.as_bytes()).map_err(state_error)?;
    file.write_all(b"\n").map_err(state_error)?;
    file.sync_all().map_err(state_error)?;
    fs::rename(temporary, target).map_err(state_error)
}

fn portal_error(error: impl std::fmt::Display) -> PortalControlError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    if lower.contains("cancel") || lower.contains("denied") || lower.contains("permission") {
        PortalControlError::Permission(message)
    } else {
        PortalControlError::Portal(message)
    }
}

fn state_error(error: impl std::fmt::Display) -> PortalControlError {
    PortalControlError::State(error.to_string())
}

#[derive(Debug, Error)]
pub enum PortalControlError {
    #[error("Wayland desktop portal failed: {0}")]
    Portal(String),
    #[error("Wayland desktop permission was not granted: {0}")]
    Permission(String),
    #[error("Wayland portal stream metadata cannot map desktop coordinate ({x}, {y})")]
    CoordinateOutsideStreams { x: f64, y: f64 },
    #[error("the accessibility element has no screen bounds for raw input fallback")]
    MissingBounds,
    #[error("invalid or unsupported key name: {0}")]
    InvalidKey(String),
    #[error("this action requires accessibility semantics")]
    SemanticOnly,
    #[error("failed to persist Wayland portal state: {0}")]
    State(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_negative_origin_monitor_to_stream_local_coordinates() {
        let streams = [
            StreamGeometry {
                node_id: 4,
                position: Some((-1920, 0)),
                size: Some((1920, 1080)),
            },
            StreamGeometry {
                node_id: 9,
                position: Some((0, 0)),
                size: Some((2560, 1440)),
            },
        ];
        assert_eq!(map_stream_point(&streams, -120.0, 40.0).unwrap(), (4, 1800.0, 40.0));
        assert_eq!(map_stream_point(&streams, 120.0, 40.0).unwrap(), (9, 120.0, 40.0));
    }

    #[test]
    fn single_stream_without_geometry_uses_its_coordinate_space() {
        let streams = [StreamGeometry {
            node_id: 12,
            position: None,
            size: None,
        }];
        assert_eq!(map_stream_point(&streams, 10.0, 20.0).unwrap(), (12, 10.0, 20.0));
    }

    #[test]
    fn parses_xdotool_style_key_chords_and_unicode() {
        assert_eq!(parse_key_chord("Ctrl+Shift+a").unwrap(), vec![0xffe3, 0xffe1, 0x61]);
        assert_eq!(parse_key_chord("KP_0").unwrap(), vec![0xffb0]);
        assert_eq!(parse_key_chord("Ctrl+plus").unwrap(), vec![0xffe3, 0x2b]);
        assert_eq!(character_keysym('A'), 0x41);
        assert_eq!(character_keysym('é'), 0xe9);
        assert_eq!(character_keysym('λ'), 0x0100_03bb);
    }
}
