use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::coordinates::LogicalRect;

/// Version of the bridge protocol implemented by this crate.
pub const PROTOCOL_VERSION: u32 = 1;

/// Stable accessibility element index exposed to the model.
///
/// IDs are monotonically allocated by [`crate::tree_diff::TreeDiffEngine`] and
/// are not reused during the life of that engine.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize,
)]
#[serde(transparent)]
pub struct ElementId(pub u64);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeRequest {
    pub protocol_version: u32,
    pub request_id: u64,
    /// Relative action deadline. The eventual daemon owns enforcement.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(flatten)]
    pub operation: BridgeOperation,
}

impl BridgeRequest {
    #[must_use]
    pub fn new(request_id: u64, operation: BridgeOperation) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            timeout_ms: None,
            operation,
        }
    }

    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(ProtocolError::UnsupportedVersion {
                received: self.protocol_version,
                supported: PROTOCOL_VERSION,
            });
        }
        if self.timeout_ms == Some(0) {
            return Err(ProtocolError::ZeroTimeout);
        }
        match &self.operation {
            BridgeOperation::GetAppState { app, .. } => validate_app(app),
            BridgeOperation::Action(action) => action.validate(),
            BridgeOperation::Cancel { target_request_id }
                if *target_request_id == self.request_id =>
            {
                Err(ProtocolError::SelfCancellation)
            }
            BridgeOperation::Probe
            | BridgeOperation::ListApps
            | BridgeOperation::Cancel { .. } => Ok(()),
        }
    }
}

/// Requests implemented by the eventual persistent Linux desktop daemon.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "params", rename_all = "snake_case")]
pub enum BridgeOperation {
    Probe,
    ListApps,
    GetAppState {
        app: String,
        #[serde(default, rename = "disableDiff", alias = "disable_diff")]
        disable_diff: bool,
    },
    Action(ActionRequest),
    Cancel {
        target_request_id: u64,
    },
}

/// Window-targeted action contract matching the upstream Sky window API.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ActionRequest {
    Click {
        app: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        element_index: Option<ElementId>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        mouse_button: Option<MouseButton>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        click_count: Option<u8>,
    },
    Drag {
        app: String,
        from_x: f64,
        from_y: f64,
        to_x: f64,
        to_y: f64,
    },
    PressKey {
        app: String,
        key: String,
    },
    TypeText {
        app: String,
        text: String,
    },
    Scroll {
        app: String,
        element_index: ElementId,
        direction: ScrollDirection,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pages: Option<f64>,
    },
    SetValue {
        app: String,
        element_index: ElementId,
        value: String,
    },
    PerformSecondaryAction {
        app: String,
        element_index: ElementId,
        action: String,
    },
    SelectText {
        app: String,
        element_index: ElementId,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        prefix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        suffix: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        selection_type: Option<TextSelectionType>,
    },
}

impl ActionRequest {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        match self {
            Self::Click {
                app,
                element_index,
                x,
                y,
                click_count,
                ..
            } => {
                validate_app(app)?;
                validate_element(*element_index)?;
                match (element_index, x, y) {
                    (Some(_), None, None) => {}
                    (None, Some(x), Some(y)) => validate_coordinates(&[*x, *y])?,
                    _ => return Err(ProtocolError::InvalidClickTarget),
                }
                if click_count.is_some_and(|count| !(1..=3).contains(&count)) {
                    return Err(ProtocolError::InvalidClickCount);
                }
                Ok(())
            }
            Self::Drag {
                app,
                from_x,
                from_y,
                to_x,
                to_y,
            } => {
                validate_app(app)?;
                validate_coordinates(&[*from_x, *from_y, *to_x, *to_y])
            }
            Self::PressKey { app, key } => {
                validate_app(app)?;
                if key.is_empty() {
                    Err(ProtocolError::EmptyKey)
                } else {
                    Ok(())
                }
            }
            Self::TypeText { app, .. } => validate_app(app),
            Self::Scroll {
                app,
                element_index,
                pages,
                ..
            } => {
                validate_app(app)?;
                validate_element(Some(*element_index))?;
                if pages.is_some_and(|pages| !pages.is_finite() || pages <= 0.0) {
                    Err(ProtocolError::InvalidPages)
                } else {
                    Ok(())
                }
            }
            Self::SetValue {
                app, element_index, ..
            } => {
                validate_app(app)?;
                validate_element(Some(*element_index))
            }
            Self::PerformSecondaryAction {
                app,
                element_index,
                action,
            } => {
                validate_app(app)?;
                validate_element(Some(*element_index))?;
                if action.is_empty() {
                    Err(ProtocolError::EmptySecondaryAction)
                } else {
                    Ok(())
                }
            }
            Self::SelectText {
                app, element_index, ..
            } => {
                validate_app(app)?;
                validate_element(Some(*element_index))
            }
        }
    }
}

fn validate_app(app: &str) -> Result<(), ProtocolError> {
    if app.is_empty() {
        Err(ProtocolError::EmptyApp)
    } else {
        Ok(())
    }
}

fn validate_element(element: Option<ElementId>) -> Result<(), ProtocolError> {
    if element.is_some_and(|id| id.0 == 0) {
        Err(ProtocolError::InvalidElementId)
    } else {
        Ok(())
    }
}

fn validate_coordinates(coordinates: &[f64]) -> Result<(), ProtocolError> {
    if coordinates.iter().all(|value| value.is_finite()) {
        Ok(())
    } else {
        Err(ProtocolError::NonFiniteCoordinate)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ProtocolError {
    #[error("unsupported protocol version {received}; this bridge implements {supported}")]
    UnsupportedVersion { received: u32, supported: u32 },
    #[error("timeout must be greater than zero")]
    ZeroTimeout,
    #[error("a cancellation request cannot target itself")]
    SelfCancellation,
    #[error("app must be a non-empty string")]
    EmptyApp,
    #[error("element IDs start at one")]
    InvalidElementId,
    #[error("click must specify either element_index or both x and y")]
    InvalidClickTarget,
    #[error("click_count must be between one and three")]
    InvalidClickCount,
    #[error("coordinates must be finite")]
    NonFiniteCoordinate,
    #[error("key must be a non-empty string")]
    EmptyKey,
    #[error("pages must be finite and greater than zero")]
    InvalidPages,
    #[error("secondary action must be a non-empty string")]
    EmptySecondaryAction,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[serde(alias = "l")]
    Left,
    #[serde(alias = "r")]
    Right,
    #[serde(alias = "m")]
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollDirection {
    #[serde(alias = "u")]
    Up,
    #[serde(alias = "d")]
    Down,
    #[serde(alias = "l")]
    Left,
    #[serde(alias = "r")]
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextSelectionType {
    Text,
    CursorBefore,
    CursorAfter,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeResponse {
    pub protocol_version: u32,
    pub request_id: u64,
    #[serde(flatten)]
    pub outcome: BridgeOutcome,
}

impl BridgeResponse {
    #[must_use]
    pub fn success(request_id: u64, result: BridgeResult) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            outcome: BridgeOutcome::Ok { result },
        }
    }

    #[must_use]
    pub fn error(request_id: u64, error: BridgeError) -> Self {
        Self {
            protocol_version: PROTOCOL_VERSION,
            request_id,
            outcome: BridgeOutcome::Error { error },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum BridgeOutcome {
    Ok { result: BridgeResult },
    Error { error: BridgeError },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "snake_case")]
pub enum BridgeResult {
    Probe(ProbeResult),
    Apps(Vec<AppInfo>),
    AppState(AppState),
    ActionComplete,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProbeResult {
    pub backend: String,
    pub capture: bool,
    pub pointer: bool,
    pub keyboard: bool,
    pub semantics: bool,
    /// Native probes advertise prerequisites only. This becomes true only
    /// after the eventual adapter has initialized an active session.
    pub active_session: bool,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_running: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub use_count: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AppState {
    pub app: String,
    #[serde(default)]
    pub screenshot: Option<Screenshot>,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Screenshot {
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BridgeError {
    pub code: BridgeErrorCode,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_bounds: Option<LogicalRect>,
    pub retryable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BridgeErrorCode {
    InvalidRequest,
    IncompatibleClientVersion,
    BackendUnavailable,
    PermissionsPending,
    PermissionsNotGranted,
    NoActiveSession,
    AppNotAllowed,
    InvalidApp,
    AmbiguousApp,
    RunningApplicationNotFound,
    AccessibilityError,
    UserStoppedSession,
    UserIntervened,
    ScreenLocked,
    Cancelled,
    Internal,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_uses_stable_tagged_wire_shape() {
        let mut request = BridgeRequest::new(
            7,
            BridgeOperation::Action(ActionRequest::SetValue {
                app: "org.example.Editor".into(),
                element_index: ElementId(41),
                value: "hello".into(),
            }),
        );
        request.timeout_ms = Some(5_000);

        let json = serde_json::to_value(&request).unwrap();
        assert_eq!(json["protocol_version"], PROTOCOL_VERSION);
        assert_eq!(json["request_id"], 7);
        assert_eq!(json["method"], "action");
        assert_eq!(json["params"]["kind"], "set_value");
        assert_eq!(json["params"]["element_index"], 41);

        let decoded: BridgeRequest = serde_json::from_value(json).unwrap();
        assert_eq!(decoded, request);
    }

    #[test]
    fn error_codes_match_sky_style_camel_case_names() {
        let response = BridgeResponse::error(
            9,
            BridgeError {
                code: BridgeErrorCode::PermissionsNotGranted,
                message: "desktop permission was denied".into(),
                target_bounds: None,
                retryable: true,
            },
        );
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["status"], "error");
        assert_eq!(json["error"]["code"], "permissionsNotGranted");
    }

    #[test]
    fn sky_app_fields_and_disable_diff_use_upstream_casing() {
        let app = AppInfo {
            id: "org.example.Editor".into(),
            display_name: Some("Editor".into()),
            is_running: Some(true),
            last_used_date: None,
            use_count: Some(3),
        };
        let app_json = serde_json::to_value(app).unwrap();
        assert_eq!(app_json["displayName"], "Editor");
        assert_eq!(app_json["isRunning"], true);
        assert_eq!(app_json["useCount"], 3);
        assert!(app_json.get("display_name").is_none());

        let request = BridgeRequest::new(
            11,
            BridgeOperation::GetAppState {
                app: "Editor".into(),
                disable_diff: true,
            },
        );
        let request_json = serde_json::to_value(request).unwrap();
        assert_eq!(request_json["params"]["disableDiff"], true);
        assert!(request_json["params"].get("disable_diff").is_none());

        let state_json = serde_json::to_value(AppState {
            app: "Editor".into(),
            screenshot: None,
            text: "tree".into(),
        })
        .unwrap();
        assert!(state_json["screenshot"].is_null());
    }

    #[test]
    fn click_requires_exactly_one_target_form() {
        let action = ActionRequest::Click {
            app: "org.example.Editor".into(),
            element_index: Some(ElementId(2)),
            x: Some(10.0),
            y: Some(20.0),
            mouse_button: None,
            click_count: None,
        };
        assert_eq!(action.validate(), Err(ProtocolError::InvalidClickTarget));
    }

    #[test]
    fn rejects_non_finite_action_coordinates() {
        let action = ActionRequest::Drag {
            app: "org.example.Editor".into(),
            from_x: 0.0,
            from_y: 0.0,
            to_x: f64::NAN,
            to_y: 20.0,
        };
        assert_eq!(
            action.validate(),
            Err(ProtocolError::NonFiniteCoordinate)
        );
    }
}
