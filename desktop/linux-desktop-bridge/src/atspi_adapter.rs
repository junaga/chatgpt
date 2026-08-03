//! Real AT-SPI semantic adapter.
//!
//! This adapter can enumerate running accessible applications, capture their
//! accessibility trees, and invoke semantic actions. It does not launch apps,
//! capture screenshots, or synthesize raw pointer/keyboard input.

use std::collections::{HashMap, HashSet};

use atspi::{
    proxy::{
        accessible::ObjectRefExt,
        proxy_ext::ProxyExt,
    },
    AccessibilityConnection, CoordType, Interface, ObjectRefOwned,
};
use thiserror::Error;

use crate::{
    coordinates::LogicalRect,
    desktop_apps,
    protocol::{ActionRequest, AppInfo, AppState, ElementId, Screenshot},
    semantic::{render_tree_update, ActionPlan, SemanticError, SemanticNodeCapabilities},
    tree_diff::{AccessibleNode, NodeKey, TreeDiffEngine, TreeSnapshot},
};

const DEFAULT_MAX_NODES: usize = 4_096;
const DEFAULT_MAX_TEXT_CHARACTERS: i32 = 16_384;

#[derive(Debug, Clone)]
struct RunningApp {
    info: AppInfo,
    root: ObjectRefOwned,
}

#[derive(Debug, Clone)]
struct ElementRecord {
    object: ObjectRefOwned,
    capabilities: SemanticNodeCapabilities,
    text: Option<String>,
    bounds: Option<LogicalRect>,
}

#[derive(Debug)]
struct AppCache {
    differ: TreeDiffEngine,
    elements: HashMap<ElementId, ElementRecord>,
}

impl Default for AppCache {
    fn default() -> Self {
        Self {
            differ: TreeDiffEngine::new(),
            elements: HashMap::new(),
        }
    }
}

#[derive(Debug)]
pub struct AtspiAdapter {
    connection: AccessibilityConnection,
    caches: HashMap<NodeKey, AppCache>,
    max_nodes: usize,
    max_text_characters: i32,
}

impl AtspiAdapter {
    pub async fn connect() -> Result<Self, AtspiAdapterError> {
        let connection = AccessibilityConnection::new()
            .await
            .map_err(|error| AtspiAdapterError::Connection(error.to_string()))?;
        Ok(Self {
            connection,
            caches: HashMap::new(),
            max_nodes: DEFAULT_MAX_NODES,
            max_text_characters: DEFAULT_MAX_TEXT_CHARACTERS,
        })
    }

    #[must_use]
    pub fn with_limits(mut self, max_nodes: usize, max_text_characters: i32) -> Self {
        self.max_nodes = max_nodes.max(1);
        self.max_text_characters = max_text_characters.max(1);
        self
    }

    pub async fn list_apps(&self) -> Result<Vec<AppInfo>, AtspiAdapterError> {
        Ok(self
            .running_apps()
            .await?
            .into_iter()
            .map(|app| app.info)
            .collect())
    }

    pub async fn get_app_state(
        &mut self,
        app: &str,
        disable_diff: bool,
    ) -> Result<AppState, AtspiAdapterError> {
        let resolved = self.resolve_app(app).await?;
        let root_key = object_key(&resolved.root)?;
        let (snapshot, records) = self.build_snapshot(&resolved.root).await?;
        let cache = self.caches.entry(root_key).or_default();
        let update = cache
            .differ
            .update(snapshot, disable_diff)
            .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;

        let ids_by_key: HashMap<_, _> = update
            .current
            .iter()
            .map(|indexed| (indexed.node.key.clone(), indexed.element_index))
            .collect();
        cache.elements = records
            .into_iter()
            .filter_map(|(key, record)| ids_by_key.get(&key).copied().map(|id| (id, record)))
            .collect();

        Ok(AppState {
            app: resolved.info.id,
            screenshot: Option::<Screenshot>::None,
            text: render_tree_update(&update),
        })
    }

    /// Execute only actions with complete AT-SPI semantics. Callers must route
    /// `RawInputUnavailable` to a separately initialized X11 or EIS adapter.
    pub async fn perform_action(
        &mut self,
        request: &ActionRequest,
    ) -> Result<(), AtspiAdapterError> {
        let app = request_app(request);
        let resolved = self.resolve_app(app).await?;
        let root_key = object_key(&resolved.root)?;
        let element_id = request_element(request).ok_or(AtspiAdapterError::RawInputUnavailable)?;
        let record = self
            .caches
            .get(&root_key)
            .ok_or(AtspiAdapterError::StateRequired)?
            .elements
            .get(&element_id)
            .cloned()
            .ok_or(AtspiAdapterError::StaleElement(element_id))?;
        let plan = ActionPlan::for_request(request, &record.capabilities, record.text.as_deref())?;
        self.execute_plan(record, plan).await
    }

    /// Return the current screen bounds for an element-targeted action. This
    /// is used only as an explicit raw-input fallback after semantic action
    /// planning reports that no equivalent AT-SPI operation exists.
    pub async fn action_target_bounds(
        &self,
        request: &ActionRequest,
    ) -> Result<Option<LogicalRect>, AtspiAdapterError> {
        let Some(element_id) = request_element(request) else {
            return Ok(None);
        };
        let resolved = self.resolve_app(request_app(request)).await?;
        let root_key = object_key(&resolved.root)?;
        Ok(self
            .caches
            .get(&root_key)
            .ok_or(AtspiAdapterError::StateRequired)?
            .elements
            .get(&element_id)
            .ok_or(AtspiAdapterError::StaleElement(element_id))?
            .bounds)
    }

    /// Best-effort app activation before raw keyboard input. AT-SPI cannot
    /// force every compositor to raise a window, so a rejected focus request
    /// is not reported as a successful activation.
    pub async fn focus_app(&self, app: &str) -> Result<(), AtspiAdapterError> {
        let resolved = self.resolve_app(app).await?;
        let root_accessible = resolved
            .root
            .as_accessible_proxy(self.connection.connection())
            .await
            .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;
        let mut candidates = vec![resolved.root.clone()];
        candidates.extend(root_accessible.get_children().await.unwrap_or_default());
        for candidate in candidates {
            let Ok(accessible) = candidate
                .as_accessible_proxy(self.connection.connection())
                .await
            else {
                continue;
            };
            let Ok(proxies) = accessible.proxies().await else {
                continue;
            };
            let Ok(component) = proxies.component().await else {
                continue;
            };
            if component.grab_focus().await.unwrap_or(false) {
                return Ok(());
            }
        }
        Err(AtspiAdapterError::FocusRejected)
    }

    async fn execute_plan(
        &self,
        record: ElementRecord,
        plan: ActionPlan,
    ) -> Result<(), AtspiAdapterError> {
        let accessible = record
            .object
            .as_accessible_proxy(self.connection.connection())
            .await
            .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;
        let proxies = accessible
            .proxies()
            .await
            .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;

        if let Ok(component) = proxies.component().await {
            let _ = component.grab_focus().await;
        }

        match plan {
            ActionPlan::InvokeAction {
                action_index, ..
            } => {
                let action = proxies
                    .action()
                    .await
                    .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;
                let index = i32::try_from(action_index)
                    .map_err(|_| AtspiAdapterError::Accessibility("action index overflow".into()))?;
                if action
                    .do_action(index)
                    .await
                    .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?
                {
                    Ok(())
                } else {
                    Err(AtspiAdapterError::ActionRejected)
                }
            }
            ActionPlan::SetEditableText { value, .. } => {
                let editable = proxies
                    .editable_text()
                    .await
                    .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;
                if editable
                    .set_text_contents(&value)
                    .await
                    .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?
                {
                    Ok(())
                } else {
                    Err(AtspiAdapterError::ActionRejected)
                }
            }
            ActionPlan::SetNumericValue { value, .. } => proxies
                .value()
                .await
                .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?
                .set_current_value(value)
                .await
                .map_err(|error| AtspiAdapterError::Accessibility(error.to_string())),
            ActionPlan::SelectText { start, end, .. } => {
                let text = proxies
                    .text()
                    .await
                    .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;
                let success = if start == end {
                    text.set_caret_offset(start).await
                } else if text.get_n_selections().await.unwrap_or(0) > 0 {
                    text.set_selection(0, start, end).await
                } else {
                    text.add_selection(start, end).await
                }
                .map_err(|error| AtspiAdapterError::Accessibility(error.to_string()))?;
                if success {
                    Ok(())
                } else {
                    Err(AtspiAdapterError::ActionRejected)
                }
            }
            ActionPlan::RawInputRequired => Err(AtspiAdapterError::RawInputUnavailable),
        }
    }

    async fn running_apps(&self) -> Result<Vec<RunningApp>, AtspiAdapterError> {
        let registry_root = self
            .connection
            .root_accessible_on_registry()
            .await
            .map_err(|error| AtspiAdapterError::Connection(error.to_string()))?;
        let roots = registry_root
            .get_children()
            .await
            .map_err(|error| AtspiAdapterError::Connection(error.to_string()))?;
        let mut apps = Vec::new();
        for root in roots {
            if root.is_null() {
                continue;
            }
            let Ok(accessible) = root
                .as_accessible_proxy(self.connection.connection())
                .await
            else {
                continue;
            };
            let display_name = accessible.name().await.unwrap_or_default();
            let id = object_key(&root)?.0;
            apps.push(RunningApp {
                info: AppInfo {
                    id,
                    display_name: (!display_name.is_empty()).then_some(display_name),
                    is_running: Some(true),
                    last_used_date: None,
                    use_count: None,
                },
                root,
            });
        }
        apps.sort_by(|left, right| {
            left.info
                .display_name
                .as_deref()
                .unwrap_or(&left.info.id)
                .to_ascii_lowercase()
                .cmp(
                    &right
                        .info
                        .display_name
                        .as_deref()
                        .unwrap_or(&right.info.id)
                        .to_ascii_lowercase(),
                )
        });
        Ok(apps)
    }

    async fn resolve_app(&self, query: &str) -> Result<RunningApp, AtspiAdapterError> {
        let apps = self.running_apps().await?;
        let infos: Vec<_> = apps.iter().map(|app| app.info.clone()).collect();
        let index = match resolve_app_index(query, &infos) {
            Ok(index) => index,
            Err(AtspiAdapterError::AppNotFound(_)) => match desktop_apps::resolve(query) {
                Ok(installed) => resolve_app_index(
                    installed.info.display_name.as_deref().unwrap_or(&installed.info.id),
                    &infos,
                )?,
                Err(desktop_apps::DesktopAppError::Ambiguous(_)) => {
                    return Err(AtspiAdapterError::AmbiguousApp(query.into()));
                }
                Err(_) => return Err(AtspiAdapterError::AppNotFound(query.into())),
            },
            Err(error) => return Err(error),
        };
        Ok(apps[index].clone())
    }

    async fn build_snapshot(
        &self,
        root: &ObjectRefOwned,
    ) -> Result<(TreeSnapshot, HashMap<NodeKey, ElementRecord>), AtspiAdapterError> {
        let mut nodes = Vec::new();
        let mut records = HashMap::new();
        let mut visited = HashSet::new();
        let mut stack = vec![(root.clone(), Option::<NodeKey>::None, 0_u32)];

        while let Some((object, parent, index_in_parent)) = stack.pop() {
            if nodes.len() >= self.max_nodes {
                return Err(AtspiAdapterError::NodeLimit(self.max_nodes));
            }
            if object.is_null() {
                continue;
            }
            let key = object_key(&object)?;
            if !visited.insert(key.clone()) {
                continue;
            }
            let accessible = match object
                .as_accessible_proxy(self.connection.connection())
                .await
            {
                Ok(accessible) => accessible,
                Err(error) if parent.is_none() => {
                    return Err(AtspiAdapterError::Accessibility(error.to_string()));
                }
                Err(_) => continue,
            };
            let name = accessible.name().await.unwrap_or_default();
            let description = accessible.description().await.unwrap_or_default();
            let role = accessible
                .get_role()
                .await
                .map(|role| role.name().to_owned())
                .unwrap_or_else(|_| "unknown".into());
            let mut states: Vec<_> = accessible
                .get_state()
                .await
                .map(|states| {
                    states
                        .into_iter()
                        .map(|state| format!("{state:?}").to_ascii_lowercase())
                        .collect()
                })
                .unwrap_or_default();
            states.sort();

            let mut capabilities = SemanticNodeCapabilities::default();
            let mut actions = Vec::new();
            let mut value = None;
            let mut text_contents = None;
            let mut bounds = None;
            if let Ok(interfaces) = accessible.get_interfaces().await {
                capabilities.editable_text = interfaces.contains(Interface::EditableText);
                capabilities.text = interfaces.contains(Interface::Text);
                capabilities.numeric_value = interfaces.contains(Interface::Value);
                capabilities.component = interfaces.contains(Interface::Component);
                if let Ok(proxies) = accessible.proxies().await {
                    if interfaces.contains(Interface::Action) {
                        if let Ok(action) = proxies.action().await {
                            actions = action
                                .get_actions()
                                .await
                                .unwrap_or_default()
                                .into_iter()
                                .map(|action| action.name)
                                .collect();
                        }
                    }
                    if capabilities.component {
                        if let Ok(component) = proxies.component().await {
                            if let Ok((x, y, width, height)) =
                                component.get_extents(CoordType::Screen).await
                            {
                                if width > 0 && height > 0 {
                                    bounds = Some(LogicalRect {
                                        x: f64::from(x),
                                        y: f64::from(y),
                                        width: f64::from(width),
                                        height: f64::from(height),
                                    });
                                }
                            }
                        }
                    }
                    if capabilities.text {
                        if let Ok(text) = proxies.text().await {
                            let count = text.character_count().await.unwrap_or(0).max(0);
                            let end = count.min(self.max_text_characters);
                            if end > 0 {
                                if let Ok(contents) = text.get_text(0, end).await {
                                    if !contents.is_empty() {
                                        value = Some(if count > end {
                                            format!("{contents}…")
                                        } else {
                                            contents.clone()
                                        });
                                        text_contents = Some(contents);
                                    }
                                }
                            }
                        }
                    } else if capabilities.numeric_value {
                        if let Ok(value_proxy) = proxies.value().await {
                            value = value_proxy
                                .text()
                                .await
                                .ok()
                                .filter(|text| !text.is_empty());
                            if value.is_none() {
                                value = value_proxy
                                    .current_value()
                                    .await
                                    .ok()
                                    .map(|number| number.to_string());
                            }
                        }
                    }
                }
            }
            capabilities.actions = actions.clone();
            nodes.push(AccessibleNode {
                key: key.clone(),
                parent,
                index_in_parent,
                role,
                name,
                description,
                value,
                states,
                actions,
                bounds,
            });
            records.insert(
                key.clone(),
                ElementRecord {
                    object: object.clone(),
                    capabilities,
                    text: text_contents,
                    bounds,
                },
            );

            let children = accessible.get_children().await.unwrap_or_default();
            for (index, child) in children.into_iter().enumerate().rev() {
                let index = u32::try_from(index)
                    .map_err(|_| AtspiAdapterError::Accessibility("child index overflow".into()))?;
                stack.push((child, Some(key.clone()), index));
            }
        }

        Ok((TreeSnapshot { nodes }, records))
    }
}

fn object_key(object: &ObjectRefOwned) -> Result<NodeKey, AtspiAdapterError> {
    let name = object
        .name_as_str()
        .ok_or_else(|| AtspiAdapterError::Accessibility("AT-SPI object has no bus name".into()))?;
    Ok(NodeKey(format!("atspi://{name}{}", object.path_as_str())))
}

fn request_app(request: &ActionRequest) -> &str {
    match request {
        ActionRequest::Click { app, .. }
        | ActionRequest::Drag { app, .. }
        | ActionRequest::PressKey { app, .. }
        | ActionRequest::TypeText { app, .. }
        | ActionRequest::Scroll { app, .. }
        | ActionRequest::SetValue { app, .. }
        | ActionRequest::PerformSecondaryAction { app, .. }
        | ActionRequest::SelectText { app, .. } => app,
    }
}

fn request_element(request: &ActionRequest) -> Option<ElementId> {
    match request {
        ActionRequest::Click { element_index, .. } => *element_index,
        ActionRequest::Scroll { element_index, .. }
        | ActionRequest::SetValue { element_index, .. }
        | ActionRequest::PerformSecondaryAction { element_index, .. }
        | ActionRequest::SelectText { element_index, .. } => Some(*element_index),
        ActionRequest::Drag { .. }
        | ActionRequest::PressKey { .. }
        | ActionRequest::TypeText { .. } => None,
    }
}

fn resolve_app_index(query: &str, apps: &[AppInfo]) -> Result<usize, AtspiAdapterError> {
    let query = query.trim();
    if query.is_empty() {
        return Err(AtspiAdapterError::AppNotFound(query.into()));
    }
    let exact: Vec<_> = apps
        .iter()
        .enumerate()
        .filter(|(_, app)| {
            app.id.eq_ignore_ascii_case(query)
                || app
                    .display_name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(query))
        })
        .map(|(index, _)| index)
        .collect();
    match exact.as_slice() {
        [index] => Ok(*index),
        [] => Err(AtspiAdapterError::AppNotFound(query.into())),
        _ => Err(AtspiAdapterError::AmbiguousApp(query.into())),
    }
}

#[derive(Debug, Error)]
pub enum AtspiAdapterError {
    #[error("AT-SPI connection failed: {0}")]
    Connection(String),
    #[error("application is not running or does not expose AT-SPI: {0}")]
    AppNotFound(String),
    #[error("application name is ambiguous: {0}")]
    AmbiguousApp(String),
    #[error("call get_app_state before using an element index")]
    StateRequired,
    #[error("element index is stale or unknown: {}", .0.0)]
    StaleElement(ElementId),
    #[error("AT-SPI accessibility operation failed: {0}")]
    Accessibility(String),
    #[error("AT-SPI action was rejected by the application")]
    ActionRejected,
    #[error("the application rejected the AT-SPI focus request")]
    FocusRejected,
    #[error("action requires a separately initialized X11 or Wayland EIS input adapter")]
    RawInputUnavailable,
    #[error("accessibility tree exceeded the {0}-node safety limit")]
    NodeLimit(usize),
    #[error(transparent)]
    Semantic(#[from] SemanticError),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str) -> AppInfo {
        AppInfo {
            id: id.into(),
            display_name: Some(name.into()),
            is_running: Some(true),
            last_used_date: None,
            use_count: None,
        }
    }

    #[test]
    fn app_resolution_accepts_id_or_exact_display_name() {
        let apps = vec![app("atspi://one/root", "Editor"), app("atspi://two/root", "Files")];
        assert_eq!(resolve_app_index("Editor", &apps).unwrap(), 0);
        assert_eq!(resolve_app_index("atspi://two/root", &apps).unwrap(), 1);
    }

    #[test]
    fn duplicate_display_names_are_ambiguous() {
        let apps = vec![app("atspi://one/root", "Editor"), app("atspi://two/root", "Editor")];
        assert!(matches!(
            resolve_app_index("Editor", &apps),
            Err(AtspiAdapterError::AmbiguousApp(_))
        ));
    }
}
