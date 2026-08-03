use std::collections::HashMap;

use crate::{
    protocol::{ActionRequest, ElementId, MouseButton, TextSelectionType},
    tree_diff::{ChangeKind, IndexedNode, TreeUpdate, TreeUpdateKind},
};
use thiserror::Error;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SemanticNodeCapabilities {
    pub actions: Vec<String>,
    pub editable_text: bool,
    pub text: bool,
    pub numeric_value: bool,
    pub component: bool,
}

/// Action selected by the platform-independent semantic layer. Native
/// adapters execute these plans or return an explicit unsupported error.
#[derive(Debug, Clone, PartialEq)]
pub enum ActionPlan {
    InvokeAction {
        element: ElementId,
        action_index: usize,
        action_name: String,
    },
    SetEditableText {
        element: ElementId,
        value: String,
    },
    SetNumericValue {
        element: ElementId,
        value: f64,
    },
    SelectText {
        element: ElementId,
        start: i32,
        end: i32,
        selection_type: TextSelectionType,
    },
    RawInputRequired,
}

impl ActionPlan {
    pub fn for_request(
        request: &ActionRequest,
        capabilities: &SemanticNodeCapabilities,
        current_text: Option<&str>,
    ) -> Result<Self, SemanticError> {
        match request {
            ActionRequest::Click {
                element_index: Some(element),
                mouse_button,
                click_count,
                ..
            } => {
                if mouse_button.is_some_and(|button| button != MouseButton::Left)
                    || click_count.is_some_and(|count| count != 1)
                {
                    return Ok(Self::RawInputRequired);
                }
                let preferred = ["click", "press", "activate"];
                let selected = preferred.iter().find_map(|preferred_name| {
                    capabilities
                        .actions
                        .iter()
                        .enumerate()
                        .find(|(_, action)| action.eq_ignore_ascii_case(preferred_name))
                });
                let (action_index, action_name) = selected
                    .or_else(|| capabilities.actions.iter().enumerate().next())
                    .ok_or(SemanticError::NoAction)?;
                Ok(Self::InvokeAction {
                    element: *element,
                    action_index,
                    action_name: action_name.clone(),
                })
            }
            ActionRequest::Click { .. }
            | ActionRequest::Drag { .. }
            | ActionRequest::PressKey { .. }
            | ActionRequest::TypeText { .. }
            | ActionRequest::Scroll { .. } => Ok(Self::RawInputRequired),
            ActionRequest::SetValue {
                element_index,
                value,
                ..
            } if capabilities.editable_text => Ok(Self::SetEditableText {
                element: *element_index,
                value: value.clone(),
            }),
            ActionRequest::SetValue {
                element_index,
                value,
                ..
            } if capabilities.numeric_value => {
                let value = value
                    .parse::<f64>()
                    .map_err(|_| SemanticError::InvalidNumericValue)?;
                if !value.is_finite() {
                    return Err(SemanticError::InvalidNumericValue);
                }
                Ok(Self::SetNumericValue {
                    element: *element_index,
                    value,
                })
            }
            ActionRequest::SetValue { .. } => Err(SemanticError::NotEditable),
            ActionRequest::PerformSecondaryAction {
                element_index,
                action,
                ..
            } => {
                let (action_index, action_name) = capabilities
                    .actions
                    .iter()
                    .enumerate()
                    .find(|(_, exposed)| exposed.eq_ignore_ascii_case(action))
                    .ok_or_else(|| SemanticError::UnknownSecondaryAction(action.clone()))?;
                Ok(Self::InvokeAction {
                    element: *element_index,
                    action_index,
                    action_name: action_name.clone(),
                })
            }
            ActionRequest::SelectText {
                element_index,
                text,
                prefix,
                suffix,
                selection_type,
                ..
            } => {
                if !capabilities.text {
                    return Err(SemanticError::TextInterfaceUnavailable);
                }
                let current_text = current_text.ok_or(SemanticError::TextInterfaceUnavailable)?;
                let (match_start, match_end) = find_text_range(
                    current_text,
                    text,
                    prefix.as_deref(),
                    suffix.as_deref(),
                )?;
                let selection_type = selection_type.unwrap_or(TextSelectionType::Text);
                let (start, end) = match selection_type {
                    TextSelectionType::Text => (match_start, match_end),
                    TextSelectionType::CursorBefore => (match_start, match_start),
                    TextSelectionType::CursorAfter => (match_end, match_end),
                };
                Ok(Self::SelectText {
                    element: *element_index,
                    start,
                    end,
                    selection_type,
                })
            }
        }
    }
}

/// Locate an unambiguous match using AT-SPI character offsets rather than UTF-8
/// byte offsets. Prefix and suffix must be immediately adjacent to the match.
pub fn find_text_range(
    haystack: &str,
    needle: &str,
    prefix: Option<&str>,
    suffix: Option<&str>,
) -> Result<(i32, i32), SemanticError> {
    if needle.is_empty() {
        return Err(SemanticError::EmptySelectionText);
    }
    let haystack: Vec<char> = haystack.chars().collect();
    let needle: Vec<char> = needle.chars().collect();
    let prefix: Option<Vec<char>> = prefix.map(|value| value.chars().collect());
    let suffix: Option<Vec<char>> = suffix.map(|value| value.chars().collect());
    let mut matches = Vec::new();

    for start in 0..=haystack.len().saturating_sub(needle.len()) {
        let end = start + needle.len();
        if haystack[start..end] != needle {
            continue;
        }
        if let Some(prefix) = &prefix {
            if start < prefix.len() || haystack[start - prefix.len()..start] != prefix[..] {
                continue;
            }
        }
        if let Some(suffix) = &suffix {
            if end + suffix.len() > haystack.len()
                || haystack[end..end + suffix.len()] != suffix[..]
            {
                continue;
            }
        }
        matches.push((start, end));
    }

    match matches.as_slice() {
        [] => Err(SemanticError::TextNotFound),
        [only] => Ok((
            i32::try_from(only.0).map_err(|_| SemanticError::TextTooLong)?,
            i32::try_from(only.1).map_err(|_| SemanticError::TextTooLong)?,
        )),
        _ => Err(SemanticError::AmbiguousText),
    }
}

/// Deterministic accessibility text for `get_app_state`. Full snapshots show
/// every current element; diffs contain only added, changed, and removed IDs.
#[must_use]
pub fn render_tree_update(update: &TreeUpdate) -> String {
    let mut lines = Vec::new();
    let ids_by_key: HashMap<_, _> = update
        .current
        .iter()
        .map(|node| (node.node.key.clone(), node.element_index))
        .collect();
    match update.kind {
        TreeUpdateKind::Full => {
            lines.push("Accessibility tree:".into());
            lines.extend(
                update
                    .current
                    .iter()
                    .map(|node| render_node("", node, &ids_by_key)),
            );
        }
        TreeUpdateKind::Diff => {
            lines.push("The following is a diff from the previous accessibility tree:".into());
            for change in &update.changes {
                match change.kind {
                    ChangeKind::Added => {
                        if let Some(node) = &change.node {
                            lines.push(render_node("+ ", node, &ids_by_key));
                        }
                    }
                    ChangeKind::Updated => {
                        if let Some(node) = &change.node {
                            let fields = change.changed_fields.join(",");
                            lines.push(format!(
                                "{} changed={fields}",
                                render_node("~ ", node, &ids_by_key)
                            ));
                        }
                    }
                    ChangeKind::Removed => lines.push(format!(
                        "- [element_index={}] removed",
                        change.element_index.0
                    )),
                }
            }
            if update.changes.is_empty() {
                lines.push("(no accessibility changes)".into());
            }
        }
    }
    lines.join("\n")
}

fn render_node(
    prefix: &str,
    indexed: &IndexedNode,
    ids_by_key: &HashMap<crate::tree_diff::NodeKey, ElementId>,
) -> String {
    let node = &indexed.node;
    let mut fields = vec![
        format!("element_index={}", indexed.element_index.0),
        format!("role={}", quoted(&node.role)),
    ];
    if let Some(parent) = node
        .parent
        .as_ref()
        .and_then(|parent| ids_by_key.get(parent))
    {
        fields.push(format!("parent_element_index={}", parent.0));
        fields.push(format!("child_index={}", node.index_in_parent));
    }
    if !node.name.is_empty() {
        fields.push(format!("name={}", quoted(&node.name)));
    }
    if !node.description.is_empty() {
        fields.push(format!("description={}", quoted(&node.description)));
    }
    if let Some(value) = &node.value {
        fields.push(format!("value={}", quoted(value)));
    }
    if !node.states.is_empty() {
        fields.push(format!("states={}", node.states.join(",")));
    }
    if !node.actions.is_empty() {
        fields.push(format!("actions={}", node.actions.join(",")));
    }
    if let Some(bounds) = node.bounds {
        fields.push(format!(
            "bounds={:.0},{:.0},{:.0},{:.0}",
            bounds.x, bounds.y, bounds.width, bounds.height
        ));
    }
    format!("{prefix}[{}]", fields.join(" "))
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("serializing a string cannot fail")
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SemanticError {
    #[error("element exposes no accessibility action")]
    NoAction,
    #[error("element is not editable")]
    NotEditable,
    #[error("value is not a finite number")]
    InvalidNumericValue,
    #[error("secondary action is not exposed by this element: {0}")]
    UnknownSecondaryAction(String),
    #[error("element does not expose the AT-SPI Text interface")]
    TextInterfaceUnavailable,
    #[error("selection text cannot be empty")]
    EmptySelectionText,
    #[error("selection text was not found")]
    TextNotFound,
    #[error("selection text is ambiguous; provide prefix or suffix")]
    AmbiguousText,
    #[error("text is too long for AT-SPI offsets")]
    TextTooLong,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        protocol::MouseButton,
        tree_diff::{AccessibleNode, NodeKey, TreeChange},
    };

    #[test]
    fn unicode_selection_uses_character_offsets() {
        assert_eq!(
            find_text_range("a😀 café", "café", None, None).unwrap(),
            (3, 7)
        );
    }

    #[test]
    fn prefix_disambiguates_repeated_text() {
        assert_eq!(
            find_text_range("first save then save", "save", Some("then "), None).unwrap(),
            (16, 20)
        );
        assert_eq!(
            find_text_range("first save then save", "save", None, None),
            Err(SemanticError::AmbiguousText)
        );
    }

    #[test]
    fn click_prefers_named_activation_action() {
        let request = ActionRequest::Click {
            app: "Editor".into(),
            element_index: Some(ElementId(4)),
            x: None,
            y: None,
            mouse_button: Some(MouseButton::Left),
            click_count: Some(1),
        };
        let capabilities = SemanticNodeCapabilities {
            actions: vec!["show menu".into(), "click".into()],
            ..SemanticNodeCapabilities::default()
        };
        assert_eq!(
            ActionPlan::for_request(&request, &capabilities, None).unwrap(),
            ActionPlan::InvokeAction {
                element: ElementId(4),
                action_index: 1,
                action_name: "click".into(),
            }
        );
    }

    #[test]
    fn right_and_multi_clicks_require_raw_input_even_for_elements() {
        let capabilities = SemanticNodeCapabilities {
            actions: vec!["click".into()],
            ..Default::default()
        };
        let request = ActionRequest::Click {
            app: "Editor".into(),
            element_index: Some(ElementId(3)),
            x: None,
            y: None,
            mouse_button: Some(MouseButton::Right),
            click_count: Some(2),
        };
        assert_eq!(
            ActionPlan::for_request(&request, &capabilities, None).unwrap(),
            ActionPlan::RawInputRequired
        );
    }

    #[test]
    fn secondary_actions_are_never_guessed() {
        let request = ActionRequest::PerformSecondaryAction {
            app: "Editor".into(),
            element_index: ElementId(4),
            action: "expand".into(),
        };
        let capabilities = SemanticNodeCapabilities {
            actions: vec!["show menu".into()],
            ..SemanticNodeCapabilities::default()
        };
        assert_eq!(
            ActionPlan::for_request(&request, &capabilities, None),
            Err(SemanticError::UnknownSecondaryAction("expand".into()))
        );
    }

    #[test]
    fn renders_diff_in_model_readable_form() {
        let indexed = IndexedNode {
            element_index: ElementId(8),
            node: AccessibleNode {
                key: NodeKey("app:/save".into()),
                parent: None,
                index_in_parent: 0,
                role: "button".into(),
                name: "Save".into(),
                description: String::new(),
                value: None,
                states: vec!["enabled".into()],
                actions: vec!["click".into()],
                bounds: None,
            },
        };
        let update = TreeUpdate {
            kind: TreeUpdateKind::Diff,
            current: vec![indexed.clone()],
            changes: vec![TreeChange {
                kind: ChangeKind::Updated,
                element_index: ElementId(8),
                key: indexed.node.key.clone(),
                node: Some(indexed),
                changed_fields: vec!["name".into()],
            }],
        };
        let rendered = render_tree_update(&update);
        assert!(rendered.contains("diff from the previous accessibility tree"));
        assert!(rendered.contains("element_index=8"));
        assert!(rendered.contains("actions=click"));
        assert!(rendered.contains("changed=name"));
    }
}
