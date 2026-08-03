use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionKind {
    Wayland,
    X11,
    Unknown,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    WaylandPortal,
    X11Sky,
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InputTransport {
    Eis,
    PortalNotify,
    X11,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WaylandPortalCapabilities {
    pub remote_desktop_version: Option<u32>,
    pub screencast_version: Option<u32>,
    pub monitor_capture: bool,
    pub pointer: bool,
    pub keyboard: bool,
    /// The interface advertises RemoteDesktop v2. This is not proof that an
    /// EIS connection has been granted or established.
    pub eis_advertised: bool,
    pub restore_tokens_advertised: bool,
    #[serde(default)]
    pub probe_errors: Vec<String>,
}

impl Default for WaylandPortalCapabilities {
    fn default() -> Self {
        Self {
            remote_desktop_version: None,
            screencast_version: None,
            monitor_capture: false,
            pointer: false,
            keyboard: false,
            eis_advertised: false,
            restore_tokens_advertised: false,
            probe_errors: Vec::new(),
        }
    }
}

impl WaylandPortalCapabilities {
    #[must_use]
    pub fn input_transport(&self) -> InputTransport {
        if !self.pointer || !self.keyboard {
            InputTransport::None
        } else if self.eis_advertised && self.remote_desktop_version.is_some_and(|v| v >= 2) {
            InputTransport::Eis
        } else if self.remote_desktop_version.is_some_and(|v| v >= 1) {
            InputTransport::PortalNotify
        } else {
            InputTransport::None
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct X11Capabilities {
    /// An X11 connection was opened successfully, not merely inferred from
    /// the DISPLAY environment variable.
    pub display_reachable: bool,
    /// The packaged Sky X11 helper exists and is executable.
    pub sky_helper_executable: bool,
    #[serde(default)]
    pub probe_errors: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendAvailability {
    pub session: SessionKind,
    pub wayland: WaylandPortalCapabilities,
    pub x11: X11Capabilities,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendRequirements {
    pub capture: bool,
    pub pointer: bool,
    pub keyboard: bool,
    /// Whether the caller requires a semantic accessibility adapter. Backend
    /// selection records this requirement but does not claim AT-SPI is active.
    pub semantics: bool,
    /// Native Wayland sessions do not silently fall back through XWayland
    /// unless the caller explicitly permits the reduced/security-different path.
    pub allow_xwayland_fallback: bool,
}

impl Default for BackendRequirements {
    fn default() -> Self {
        Self {
            capture: true,
            pointer: true,
            keyboard: true,
            semantics: true,
            allow_xwayland_fallback: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BackendSelection {
    pub backend: BackendKind,
    pub input_transport: InputTransport,
    /// Selection confirms prerequisites, not an initialized desktop session.
    pub active_session: bool,
    pub capture_advertised: bool,
    pub pointer_advertised: bool,
    pub keyboard_advertised: bool,
    /// Always false in this foundation until an AT-SPI adapter initializes.
    pub semantics_active: bool,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[must_use]
pub fn select_backend(
    availability: &BackendAvailability,
    requirements: BackendRequirements,
) -> BackendSelection {
    let portal_capture = availability.wayland.monitor_capture
        && availability.wayland.screencast_version.is_some_and(|v| v >= 1);
    let portal_input = availability.wayland.input_transport();
    let portal_satisfies = (!requirements.capture || portal_capture)
        && (!requirements.pointer
            || (availability.wayland.pointer && portal_input != InputTransport::None))
        && (!requirements.keyboard
            || (availability.wayland.keyboard && portal_input != InputTransport::None));

    let x11_capture = availability.x11.display_reachable
        && availability.x11.sky_helper_executable;
    let x11_satisfies = (!requirements.capture || x11_capture)
        && (!requirements.pointer || x11_capture)
        && (!requirements.keyboard || x11_capture);

    let prefer_portal = matches!(availability.session, SessionKind::Wayland)
        || matches!(availability.session, SessionKind::Unknown);
    let permit_x11 = !matches!(availability.session, SessionKind::Wayland)
        || requirements.allow_xwayland_fallback;

    if prefer_portal && portal_satisfies {
        return selection_for_portal(availability, requirements, portal_capture, portal_input);
    }
    if permit_x11 && x11_satisfies {
        let mut notes = vec![
            "X11 display and packaged helper were probed, but no control session is active"
                .into(),
        ];
        if matches!(availability.session, SessionKind::Wayland) {
            notes.push("using the explicitly allowed XWayland fallback; native Wayland guarantees do not apply".into());
        }
        if requirements.semantics {
            notes.push("semantic actions remain unavailable until the AT-SPI adapter initializes".into());
        }
        return BackendSelection {
            backend: BackendKind::X11Sky,
            input_transport: InputTransport::X11,
            active_session: false,
            capture_advertised: true,
            pointer_advertised: true,
            keyboard_advertised: true,
            semantics_active: false,
            notes,
        };
    }
    if !prefer_portal && portal_satisfies {
        return selection_for_portal(availability, requirements, portal_capture, portal_input);
    }

    let mut notes = Vec::new();
    if matches!(availability.session, SessionKind::Wayland)
        && !requirements.allow_xwayland_fallback
        && x11_satisfies
    {
        notes.push("X11 prerequisites exist, but XWayland fallback is disabled for a native Wayland session".into());
    }
    if requirements.capture && !portal_capture && !x11_capture {
        notes.push("no complete screen-capture backend was advertised".into());
    }
    if (requirements.pointer || requirements.keyboard) && portal_input == InputTransport::None
        && !x11_satisfies
    {
        notes.push("no backend advertised both pointer and keyboard injection".into());
    }
    if requirements.semantics {
        notes.push("the AT-SPI semantic adapter has not been initialized".into());
    }

    BackendSelection {
        backend: BackendKind::Unavailable,
        input_transport: InputTransport::None,
        active_session: false,
        capture_advertised: false,
        pointer_advertised: false,
        keyboard_advertised: false,
        semantics_active: false,
        notes,
    }
}

fn selection_for_portal(
    availability: &BackendAvailability,
    requirements: BackendRequirements,
    capture: bool,
    input_transport: InputTransport,
) -> BackendSelection {
    let mut notes = vec![
        "portal interfaces advertise prerequisites, but permission and an active session are still required"
            .into(),
    ];
    if input_transport == InputTransport::PortalNotify {
        notes.push("ConnectToEIS is not advertised; the implementation must use portal Notify methods exclusively".into());
    }
    if requirements.semantics {
        notes.push("semantic actions remain unavailable until the AT-SPI adapter initializes".into());
    }
    BackendSelection {
        backend: BackendKind::WaylandPortal,
        input_transport,
        active_session: false,
        capture_advertised: capture,
        pointer_advertised: availability.wayland.pointer,
        keyboard_advertised: availability.wayland.keyboard,
        semantics_active: false,
        notes,
    }
}

#[cfg(feature = "native-probes")]
pub mod native {
    use std::{fs, os::unix::fs::PermissionsExt, path::Path};

    use ashpd::desktop::{
        remote_desktop::{DeviceType, RemoteDesktop},
        screencast::{Screencast, SourceType},
    };

    use super::{BackendAvailability, SessionKind, WaylandPortalCapabilities, X11Capabilities};

    #[derive(Debug, Clone, Copy)]
    pub struct EnvironmentHints<'a> {
        pub xdg_session_type: Option<&'a str>,
        pub wayland_display: Option<&'a str>,
        pub display: Option<&'a str>,
    }

    impl EnvironmentHints<'_> {
        #[must_use]
        pub fn session_kind(self) -> SessionKind {
            match self.xdg_session_type.map(str::to_ascii_lowercase).as_deref() {
                Some("wayland") => SessionKind::Wayland,
                Some("x11") => SessionKind::X11,
                _ if self.wayland_display.is_some_and(|v| !v.is_empty()) => SessionKind::Wayland,
                _ if self.display.is_some_and(|v| !v.is_empty()) => SessionKind::X11,
                _ => SessionKind::Unknown,
            }
        }
    }

    /// Probe advertised portal properties without requesting permission or
    /// creating a desktop-control session.
    pub async fn probe_wayland_portal() -> WaylandPortalCapabilities {
        let mut result = WaylandPortalCapabilities::default();

        match RemoteDesktop::new().await {
            Ok(remote_desktop) => {
                let version = remote_desktop.version();
                result.remote_desktop_version = Some(version);
                result.eis_advertised = version >= 2;
                result.restore_tokens_advertised = version >= 1;
                match remote_desktop.available_device_types().await {
                    Ok(types) => {
                        result.pointer = types.contains(DeviceType::Pointer);
                        result.keyboard = types.contains(DeviceType::Keyboard);
                    }
                    Err(error) => result
                        .probe_errors
                        .push(format!("RemoteDesktop device probe failed: {error}")),
                }
            }
            Err(error) => result
                .probe_errors
                .push(format!("RemoteDesktop portal unavailable: {error}")),
        }

        match Screencast::new().await {
            Ok(screencast) => {
                result.screencast_version = Some(screencast.version());
                match screencast.available_source_types().await {
                    Ok(types) => result.monitor_capture = types.contains(SourceType::Monitor),
                    Err(error) => result
                        .probe_errors
                        .push(format!("ScreenCast source probe failed: {error}")),
                }
            }
            Err(error) => result
                .probe_errors
                .push(format!("ScreenCast portal unavailable: {error}")),
        }

        result
    }

    /// Open an X11 connection and verify the configured Sky helper. Merely
    /// having DISPLAY set is insufficient.
    #[must_use]
    pub fn probe_x11(sky_helper: Option<&Path>) -> X11Capabilities {
        let mut result = X11Capabilities::default();
        match x11rb::connect(None) {
            Ok((_connection, _screen)) => result.display_reachable = true,
            Err(error) => result
                .probe_errors
                .push(format!("X11 connection failed: {error}")),
        }

        match sky_helper {
            Some(path) => match fs::metadata(path) {
                Ok(metadata) => {
                    result.sky_helper_executable = metadata.is_file()
                        && metadata.permissions().mode() & 0o111 != 0;
                    if !result.sky_helper_executable {
                        result.probe_errors.push(format!(
                            "Sky helper is not an executable file: {}",
                            path.display()
                        ));
                    }
                }
                Err(error) => result.probe_errors.push(format!(
                    "Sky helper metadata probe failed for {}: {error}",
                    path.display()
                )),
            },
            None => result
                .probe_errors
                .push("Sky helper path was not configured".into()),
        }

        result
    }

    pub async fn probe_all(
        hints: EnvironmentHints<'_>,
        sky_helper: Option<&Path>,
    ) -> BackendAvailability {
        BackendAvailability {
            session: hints.session_kind(),
            wayland: probe_wayland_portal().await,
            x11: probe_x11(sky_helper),
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn explicit_session_type_wins_over_display_hints() {
            let hints = EnvironmentHints {
                xdg_session_type: Some("wayland"),
                wayland_display: None,
                display: Some(":0"),
            };
            assert_eq!(hints.session_kind(), SessionKind::Wayland);
        }

        #[test]
        fn display_hints_are_used_when_session_type_is_missing() {
            let hints = EnvironmentHints {
                xdg_session_type: None,
                wayland_display: Some("wayland-0"),
                display: Some(":0"),
            };
            assert_eq!(hints.session_kind(), SessionKind::Wayland);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn availability(session: SessionKind) -> BackendAvailability {
        BackendAvailability {
            session,
            wayland: WaylandPortalCapabilities {
                remote_desktop_version: Some(2),
                screencast_version: Some(6),
                monitor_capture: true,
                pointer: true,
                keyboard: true,
                eis_advertised: true,
                restore_tokens_advertised: true,
                probe_errors: Vec::new(),
            },
            x11: X11Capabilities {
                display_reachable: true,
                sky_helper_executable: true,
                probe_errors: Vec::new(),
            },
        }
    }

    #[test]
    fn native_wayland_prefers_portal_and_does_not_claim_active_session() {
        let selected = select_backend(
            &availability(SessionKind::Wayland),
            BackendRequirements::default(),
        );
        assert_eq!(selected.backend, BackendKind::WaylandPortal);
        assert_eq!(selected.input_transport, InputTransport::Eis);
        assert!(!selected.active_session);
        assert!(!selected.semantics_active);
    }

    #[test]
    fn wayland_does_not_silently_fall_back_to_xwayland() {
        let mut available = availability(SessionKind::Wayland);
        available.wayland = WaylandPortalCapabilities::default();

        let selected = select_backend(&available, BackendRequirements::default());
        assert_eq!(selected.backend, BackendKind::Unavailable);
        assert!(selected.notes.iter().any(|note| note.contains("fallback is disabled")));
    }

    #[test]
    fn xwayland_fallback_requires_explicit_opt_in() {
        let mut available = availability(SessionKind::Wayland);
        available.wayland = WaylandPortalCapabilities::default();
        let requirements = BackendRequirements {
            allow_xwayland_fallback: true,
            ..BackendRequirements::default()
        };

        let selected = select_backend(&available, requirements);
        assert_eq!(selected.backend, BackendKind::X11Sky);
        assert_eq!(selected.input_transport, InputTransport::X11);
    }

    #[test]
    fn portal_notify_is_an_explicit_non_eis_transport() {
        let mut available = availability(SessionKind::Wayland);
        available.wayland.remote_desktop_version = Some(1);
        available.wayland.eis_advertised = false;

        let selected = select_backend(&available, BackendRequirements::default());
        assert_eq!(selected.backend, BackendKind::WaylandPortal);
        assert_eq!(selected.input_transport, InputTransport::PortalNotify);
    }
}
