//! Shared foundations for Linux desktop control.
//!
//! Capability probes never imply an initialized control session. The separate
//! packaged binaries build active AT-SPI/desktop-portal Computer Use sessions
//! and global-dictation shortcut/paste sessions on top of these foundations.

pub mod backend;
pub mod coordinates;
pub mod desktop_apps;
pub mod protocol;
pub mod semantic;
pub mod tree_diff;
pub mod wire;

#[cfg(feature = "native-atspi")]
pub mod atspi_adapter;
#[cfg(feature = "native-probes")]
pub mod portal_control;

pub use backend::{
    select_backend, BackendAvailability, BackendKind, BackendRequirements, BackendSelection,
    InputTransport, SessionKind, WaylandPortalCapabilities, X11Capabilities,
};
pub use coordinates::{
    CoordinateError, DesktopLayout, FramePoint, FrameSize, FrameTransform, LogicalPoint,
    LogicalRect, MonitorGeometry, TargetPoint,
};
pub use protocol::{
    ActionRequest, AppInfo, AppState, BridgeError, BridgeErrorCode, BridgeOperation,
    BridgeOutcome, BridgeRequest, BridgeResponse, BridgeResult, ElementId, ProtocolError,
    PROTOCOL_VERSION,
};
pub use semantic::{
    find_text_range, render_tree_update, ActionPlan, SemanticError, SemanticNodeCapabilities,
};
pub use tree_diff::{
    AccessibleNode, ChangeKind, IndexedNode, NodeKey, TreeChange, TreeDiffEngine, TreeError,
    TreeSnapshot, TreeUpdate, TreeUpdateKind,
};
pub use wire::{read_frame, write_frame, WireError, MAX_FRAME_BYTES};
