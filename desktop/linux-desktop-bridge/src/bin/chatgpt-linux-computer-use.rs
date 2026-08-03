#[cfg(all(feature = "native-atspi", feature = "native-probes"))]
mod native {
    use std::{env, io, process::ExitCode};

    use chatgpt_linux_desktop_bridge::{
        atspi_adapter::{AtspiAdapter, AtspiAdapterError},
        coordinates::LogicalRect,
        desktop_apps::{self, DesktopAppError},
        portal_control::{self, PortalControl, PortalControlError},
        read_frame, write_frame, BridgeError, BridgeErrorCode, BridgeOperation, BridgeOutcome,
        BridgeRequest, BridgeResponse, BridgeResult,
        protocol::ProbeResult,
        semantic::SemanticError,
    };

    struct ComputerUseService {
        adapter: AtspiAdapter,
        portal: Option<PortalControl>,
        wayland: bool,
        portal_capture_active: bool,
    }

    impl ComputerUseService {
        async fn new() -> Result<Self, AtspiAdapterError> {
            let session_type = env::var("XDG_SESSION_TYPE")
                .unwrap_or_default()
                .to_ascii_lowercase();
            let wayland = session_type == "wayland"
                || (session_type.is_empty()
                    && env::var_os("WAYLAND_DISPLAY").is_some()
                    && env::var_os("DISPLAY").is_none());
            Ok(Self {
                adapter: AtspiAdapter::connect().await?,
                portal: None,
                wayland,
                portal_capture_active: false,
            })
        }

        async fn get_app_state(
            &mut self,
            app: &str,
            disable_diff: bool,
        ) -> Result<chatgpt_linux_desktop_bridge::AppState, ServiceError> {
            let mut state = match self.adapter.get_app_state(app, disable_diff).await {
                Ok(state) => state,
                Err(AtspiAdapterError::AppNotFound(_)) => {
                    let installed = desktop_apps::resolve(app).map_err(ServiceError::Desktop)?;
                    let display_name = installed
                        .info
                        .display_name
                        .as_deref()
                        .unwrap_or(&installed.info.id)
                        .to_owned();
                    match self.adapter.get_app_state(&display_name, disable_diff).await {
                        Ok(state) => state,
                        Err(AtspiAdapterError::AppNotFound(_)) => {
                            desktop_apps::launch(&installed).map_err(ServiceError::Desktop)?;
                            let mut last_error = None;
                            let mut state = None;
                            for _ in 0..50 {
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                match self.adapter.get_app_state(&display_name, disable_diff).await {
                                    Ok(current) => {
                                        state = Some(current);
                                        break;
                                    }
                                    Err(error) => last_error = Some(error),
                                }
                            }
                            state.ok_or_else(|| {
                                ServiceError::Atspi(last_error.unwrap_or_else(|| {
                                    AtspiAdapterError::AppNotFound(display_name)
                                }))
                            })?
                        }
                        Err(error) => return Err(ServiceError::Atspi(error)),
                    }
                }
                Err(error) => return Err(ServiceError::Atspi(error)),
            };
            if self.wayland {
                match portal_control::screenshot_url().await {
                    Ok(url) => {
                        self.portal_capture_active = true;
                        state.screenshot = Some(chatgpt_linux_desktop_bridge::protocol::Screenshot {
                            url,
                        });
                    }
                    Err(error) => {
                        self.portal_capture_active = false;
                        state.text.push_str("\nScreenshot unavailable: ");
                        state.text.push_str(&error.to_string());
                    }
                }
            }
            Ok(state)
        }

        async fn list_apps(
            &self,
        ) -> Result<Vec<chatgpt_linux_desktop_bridge::AppInfo>, ServiceError> {
            let running = self
                .adapter
                .list_apps()
                .await
                .map_err(ServiceError::Atspi)?;
            let mut installed: Vec<_> = desktop_apps::discover()
                .into_iter()
                .map(|app| app.info)
                .collect();
            for app in &mut installed {
                app.is_running = Some(running.iter().any(|running| {
                    running.display_name.as_deref().is_some_and(|running_name| {
                        app.display_name
                            .as_deref()
                            .is_some_and(|installed_name| running_name.eq_ignore_ascii_case(installed_name))
                    })
                }));
            }
            for running_app in running {
                let already_listed = running_app.display_name.as_deref().is_some_and(|running_name| {
                    installed.iter().any(|installed_app| {
                        installed_app
                            .display_name
                            .as_deref()
                            .is_some_and(|installed_name| running_name.eq_ignore_ascii_case(installed_name))
                    })
                });
                if !already_listed {
                    installed.push(running_app);
                }
            }
            Ok(installed)
        }

        async fn perform_action(
            &mut self,
            action: &chatgpt_linux_desktop_bridge::ActionRequest,
        ) -> Result<(), ServiceError> {
            match self.adapter.perform_action(action).await {
                Ok(()) => return Ok(()),
                Err(error) if raw_fallback_allowed(&error) => {
                    let bounds = self
                        .adapter
                        .action_target_bounds(action)
                        .await
                        .map_err(ServiceError::Atspi)?;
                    if action_uses_keyboard(action) {
                        self.adapter
                            .focus_app(action_app(action))
                            .await
                            .map_err(|source| ServiceError::Action {
                                source,
                                target_bounds: bounds,
                            })?;
                    }
                    if !self.wayland {
                        return Err(ServiceError::Action {
                            source: error,
                            target_bounds: bounds,
                        });
                    }
                    if self.portal.is_none() {
                        self.portal = Some(
                            PortalControl::connect()
                                .await
                                .map_err(|source| ServiceError::Portal {
                                    source,
                                    target_bounds: bounds,
                                })?,
                        );
                    }
                    self.portal
                        .as_ref()
                        .expect("portal was initialized")
                        .perform_action(action, bounds)
                        .await
                        .map_err(|source| ServiceError::Portal {
                            source,
                            target_bounds: bounds,
                        })
                }
                Err(error) => Err(ServiceError::Atspi(error)),
            }
        }

        fn probe(&self) -> ProbeResult {
            let pointer = self
                .portal
                .as_ref()
                .is_some_and(PortalControl::pointer_active);
            let keyboard = self
                .portal
                .as_ref()
                .is_some_and(PortalControl::keyboard_active);
            ProbeResult {
                backend: if self.wayland {
                    "atspi+xdg-portals".into()
                } else {
                    "atspi+x11-sky-client".into()
                },
                capture: self.portal_capture_active,
                pointer,
                keyboard,
                semantics: true,
                active_session: true,
                notes: vec![if self.wayland {
                    "AT-SPI is active; portal capabilities become active only after compositor authorization"
                        .into()
                } else {
                    "AT-SPI is active; X11 capture and raw input are supplied by the bundled @oai/sky Linux client"
                        .into()
                }],
            }
        }
    }

    pub fn main() -> ExitCode {
        let runtime = match tokio::runtime::Builder::new_current_thread().build() {
            Ok(runtime) => runtime,
            Err(error) => {
                eprintln!("failed to start Computer Use runtime: {error}");
                return ExitCode::FAILURE;
            }
        };
        runtime.block_on(run())
    }

    async fn run() -> ExitCode {
        if env::args().nth(1).as_deref() != Some("serve") {
            eprintln!("usage: chatgpt-linux-computer-use serve");
            return ExitCode::FAILURE;
        }
        let mut service = match ComputerUseService::new().await {
            Ok(service) => service,
            Err(error) => {
                eprintln!("{error}");
                return ExitCode::FAILURE;
            }
        };
        let mut input = io::stdin().lock();
        let mut output = io::stdout().lock();
        loop {
            let request = match read_frame::<BridgeRequest>(&mut input) {
                Ok(Some(request)) => request,
                Ok(None) => return ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("invalid Computer Use request: {error}");
                    return ExitCode::FAILURE;
                }
            };
            let response = dispatch(&mut service, request).await;
            if let Err(error) = write_frame(&mut output, &response) {
                eprintln!("failed to write Computer Use response: {error}");
                return ExitCode::FAILURE;
            }
        }
    }

    async fn dispatch(service: &mut ComputerUseService, request: BridgeRequest) -> BridgeResponse {
        let request_id = request.request_id;
        if let Err(error) = request.validate() {
            return BridgeResponse::error(
                request_id,
                BridgeError {
                    code: BridgeErrorCode::InvalidRequest,
                    message: error.to_string(),
                    target_bounds: None,
                    retryable: false,
                },
            );
        }

        let result: Result<BridgeResult, ServiceError> = match request.operation {
            BridgeOperation::Probe => Ok(BridgeResult::Probe(service.probe())),
            BridgeOperation::ListApps => service
                .list_apps()
                .await
                .map(BridgeResult::Apps),
            BridgeOperation::GetAppState { app, disable_diff } => service
                .get_app_state(&app, disable_diff)
                .await
                .map(BridgeResult::AppState),
            BridgeOperation::Action(action) => service
                .perform_action(&action)
                .await
                .map(|()| BridgeResult::ActionComplete),
            BridgeOperation::Cancel { .. } => Err(ServiceError::Atspi(
                AtspiAdapterError::Accessibility(
                    "request cancellation is not implemented by the sequential server".into(),
                ),
            )),
        };

        match result {
            Ok(result) => BridgeResponse::success(request_id, result),
            Err(error) => BridgeResponse {
                protocol_version: chatgpt_linux_desktop_bridge::PROTOCOL_VERSION,
                request_id,
                outcome: BridgeOutcome::Error {
                    error: bridge_error(error),
                },
            },
        }
    }

    fn bridge_error(error: ServiceError) -> BridgeError {
        let (error, target_bounds, portal_permission) = match error {
            ServiceError::Atspi(error) => (Some(error), None, None),
            ServiceError::Action {
                source,
                target_bounds,
            } => (Some(source), target_bounds, None),
            ServiceError::Portal {
                source,
                target_bounds,
            } => (None, target_bounds, Some(source)),
            ServiceError::Desktop(error) => {
                let (code, retryable) = match error {
                    DesktopAppError::NotFound(_) => {
                        (BridgeErrorCode::RunningApplicationNotFound, false)
                    }
                    DesktopAppError::Ambiguous(_) => (BridgeErrorCode::AmbiguousApp, false),
                    DesktopAppError::Launch(_) | DesktopAppError::Io(_) => {
                        (BridgeErrorCode::BackendUnavailable, true)
                    }
                };
                return BridgeError {
                    code,
                    message: error.to_string(),
                    target_bounds: None,
                    retryable,
                };
            }
        };
        if let Some(error) = portal_permission {
            let code = match error {
                PortalControlError::Permission(_) => BridgeErrorCode::PermissionsNotGranted,
                PortalControlError::CoordinateOutsideStreams { .. }
                | PortalControlError::MissingBounds
                | PortalControlError::InvalidKey(_)
                | PortalControlError::SemanticOnly => BridgeErrorCode::InvalidRequest,
                PortalControlError::Portal(_) | PortalControlError::State(_) => {
                    BridgeErrorCode::BackendUnavailable
                }
            };
            return BridgeError {
                code,
                message: error.to_string(),
                target_bounds,
                retryable: matches!(code, BridgeErrorCode::BackendUnavailable),
            };
        }
        let error = error.expect("service errors contain one native source");
        let (code, retryable) = match error {
            AtspiAdapterError::Connection(_) => (BridgeErrorCode::BackendUnavailable, true),
            AtspiAdapterError::AppNotFound(_) => {
                (BridgeErrorCode::RunningApplicationNotFound, true)
            }
            AtspiAdapterError::AmbiguousApp(_) => (BridgeErrorCode::AmbiguousApp, false),
            AtspiAdapterError::RawInputUnavailable => (BridgeErrorCode::NoActiveSession, true),
            AtspiAdapterError::StateRequired | AtspiAdapterError::StaleElement(_) => {
                (BridgeErrorCode::AccessibilityError, true)
            }
            AtspiAdapterError::Accessibility(_)
            | AtspiAdapterError::ActionRejected
            | AtspiAdapterError::FocusRejected
            | AtspiAdapterError::NodeLimit(_)
            | AtspiAdapterError::Semantic(_) => (BridgeErrorCode::AccessibilityError, false),
        };
        BridgeError {
            code,
            message: error.to_string(),
            target_bounds,
            retryable,
        }
    }

    fn raw_fallback_allowed(error: &AtspiAdapterError) -> bool {
        matches!(
            error,
            AtspiAdapterError::RawInputUnavailable
                | AtspiAdapterError::Semantic(SemanticError::NoAction)
        )
    }

    fn action_uses_keyboard(action: &chatgpt_linux_desktop_bridge::ActionRequest) -> bool {
        matches!(
            action,
            chatgpt_linux_desktop_bridge::ActionRequest::PressKey { .. }
                | chatgpt_linux_desktop_bridge::ActionRequest::TypeText { .. }
        )
    }

    fn action_app(action: &chatgpt_linux_desktop_bridge::ActionRequest) -> &str {
        match action {
            chatgpt_linux_desktop_bridge::ActionRequest::Click { app, .. }
            | chatgpt_linux_desktop_bridge::ActionRequest::Drag { app, .. }
            | chatgpt_linux_desktop_bridge::ActionRequest::PressKey { app, .. }
            | chatgpt_linux_desktop_bridge::ActionRequest::TypeText { app, .. }
            | chatgpt_linux_desktop_bridge::ActionRequest::Scroll { app, .. }
            | chatgpt_linux_desktop_bridge::ActionRequest::SetValue { app, .. }
            | chatgpt_linux_desktop_bridge::ActionRequest::PerformSecondaryAction {
                app, ..
            }
            | chatgpt_linux_desktop_bridge::ActionRequest::SelectText { app, .. } => app,
        }
    }

    enum ServiceError {
        Atspi(AtspiAdapterError),
        Action {
            source: AtspiAdapterError,
            target_bounds: Option<LogicalRect>,
        },
        Portal {
            source: PortalControlError,
            target_bounds: Option<LogicalRect>,
        },
        Desktop(DesktopAppError),
    }
}

#[cfg(all(feature = "native-atspi", feature = "native-probes"))]
fn main() -> std::process::ExitCode {
    native::main()
}

#[cfg(not(all(feature = "native-atspi", feature = "native-probes")))]
fn main() -> std::process::ExitCode {
    eprintln!("chatgpt-linux-computer-use was built without native-atspi/native-probes support");
    std::process::ExitCode::FAILURE
}
