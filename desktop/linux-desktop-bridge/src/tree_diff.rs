use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::{coordinates::LogicalRect, protocol::ElementId};

/// Stable platform identity of an AT-SPI accessible object. The adapter should
/// build this from the application's bus name and object path.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NodeKey(pub String);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AccessibleNode {
    pub key: NodeKey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent: Option<NodeKey>,
    /// Sibling position reported by the accessibility adapter.
    pub index_in_parent: u32,
    pub role: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default)]
    pub states: Vec<String>,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bounds: Option<LogicalRect>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeSnapshot {
    /// Nodes in deterministic pre-order. This order is retained in full
    /// updates and used to order additions/updates in diffs.
    pub nodes: Vec<AccessibleNode>,
}

impl TreeSnapshot {
    pub fn validate(&self) -> Result<(), TreeError> {
        if self.nodes.is_empty() {
            return Err(TreeError::EmptyTree);
        }
        let keys: HashSet<&NodeKey> = self.nodes.iter().map(|node| &node.key).collect();
        if keys.len() != self.nodes.len() {
            return Err(TreeError::DuplicateNodeKey);
        }
        let roots: Vec<_> = self
            .nodes
            .iter()
            .filter(|node| node.parent.is_none())
            .collect();
        if roots.len() != 1 {
            return Err(TreeError::RootCount(roots.len()));
        }
        for node in &self.nodes {
            if let Some(parent) = &node.parent {
                if parent == &node.key {
                    return Err(TreeError::SelfParent(node.key.clone()));
                }
                if !keys.contains(parent) {
                    return Err(TreeError::MissingParent {
                        node: node.key.clone(),
                        parent: parent.clone(),
                    });
                }
            }
        }
        for node in &self.nodes {
            let mut seen = HashSet::new();
            let mut cursor = node;
            while let Some(parent_key) = &cursor.parent {
                if !seen.insert(cursor.key.clone()) {
                    return Err(TreeError::ParentCycle(node.key.clone()));
                }
                cursor = self
                    .nodes
                    .iter()
                    .find(|candidate| &candidate.key == parent_key)
                    .expect("missing parents were checked above");
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IndexedNode {
    pub element_index: ElementId,
    #[serde(flatten)]
    pub node: AccessibleNode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TreeUpdateKind {
    Full,
    Diff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Added,
    Updated,
    Removed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeChange {
    pub kind: ChangeKind,
    pub element_index: ElementId,
    pub key: NodeKey,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<IndexedNode>,
    #[serde(default)]
    pub changed_fields: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TreeUpdate {
    pub kind: TreeUpdateKind,
    /// Complete current indexed tree. Consumers use this to resolve model IDs
    /// even when `changes` contains only a diff.
    pub current: Vec<IndexedNode>,
    pub changes: Vec<TreeChange>,
}

/// Per-app engine assigning monotonic IDs and comparing accessibility trees.
/// Use one engine per resolved application target.
#[derive(Debug, Default)]
pub struct TreeDiffEngine {
    next_id: u64,
    ids: HashMap<NodeKey, ElementId>,
    previous: BTreeMap<NodeKey, AccessibleNode>,
    previous_order: Vec<NodeKey>,
}

impl TreeDiffEngine {
    #[must_use]
    pub fn new() -> Self {
        Self {
            next_id: 1,
            ids: HashMap::new(),
            previous: BTreeMap::new(),
            previous_order: Vec::new(),
        }
    }

    pub fn update(
        &mut self,
        snapshot: TreeSnapshot,
        disable_diff: bool,
    ) -> Result<TreeUpdate, TreeError> {
        snapshot.validate()?;
        let mut current = Vec::with_capacity(snapshot.nodes.len());
        let mut current_by_key = BTreeMap::new();

        for node in snapshot.nodes {
            let element_index = match self.ids.get(&node.key) {
                Some(id) => *id,
                None => {
                    let id = ElementId(self.next_id);
                    self.next_id = self.next_id.checked_add(1).ok_or(TreeError::IdExhausted)?;
                    self.ids.insert(node.key.clone(), id);
                    id
                }
            };
            current_by_key.insert(node.key.clone(), node.clone());
            current.push(IndexedNode {
                element_index,
                node,
            });
        }

        let kind = if disable_diff || self.previous.is_empty() {
            TreeUpdateKind::Full
        } else {
            TreeUpdateKind::Diff
        };
        let changes = if kind == TreeUpdateKind::Full {
            current
                .iter()
                .map(|node| TreeChange {
                    kind: ChangeKind::Added,
                    element_index: node.element_index,
                    key: node.node.key.clone(),
                    node: Some(node.clone()),
                    changed_fields: Vec::new(),
                })
                .collect()
        } else {
            self.diff(&current, &current_by_key)
        };

        for key in self
            .previous
            .keys()
            .filter(|key| !current_by_key.contains_key(*key))
        {
            self.ids.remove(key);
        }
        self.previous_order = current
            .iter()
            .map(|node| node.node.key.clone())
            .collect();
        self.previous = current_by_key;
        Ok(TreeUpdate {
            kind,
            current,
            changes,
        })
    }

    fn diff(
        &self,
        current: &[IndexedNode],
        current_by_key: &BTreeMap<NodeKey, AccessibleNode>,
    ) -> Vec<TreeChange> {
        let mut changes = Vec::new();
        for indexed in current {
            match self.previous.get(&indexed.node.key) {
                None => changes.push(TreeChange {
                    kind: ChangeKind::Added,
                    element_index: indexed.element_index,
                    key: indexed.node.key.clone(),
                    node: Some(indexed.clone()),
                    changed_fields: Vec::new(),
                }),
                Some(previous) if previous != &indexed.node => changes.push(TreeChange {
                    kind: ChangeKind::Updated,
                    element_index: indexed.element_index,
                    key: indexed.node.key.clone(),
                    node: Some(indexed.clone()),
                    changed_fields: changed_fields(previous, &indexed.node),
                }),
                Some(_) => {}
            }
        }

        // Reverse prior pre-order removes children before their parents.
        for key in self.previous_order.iter().rev() {
            if !current_by_key.contains_key(key) {
                changes.push(TreeChange {
                    kind: ChangeKind::Removed,
                    element_index: self.ids[key],
                    key: key.clone(),
                    node: None,
                    changed_fields: Vec::new(),
                });
            }
        }
        changes
    }
}

fn changed_fields(before: &AccessibleNode, after: &AccessibleNode) -> Vec<String> {
    let mut fields = Vec::new();
    if before.parent != after.parent {
        fields.push("parent".into());
    }
    if before.index_in_parent != after.index_in_parent {
        fields.push("index_in_parent".into());
    }
    if before.role != after.role {
        fields.push("role".into());
    }
    if before.name != after.name {
        fields.push("name".into());
    }
    if before.description != after.description {
        fields.push("description".into());
    }
    if before.value != after.value {
        fields.push("value".into());
    }
    if before.states != after.states {
        fields.push("states".into());
    }
    if before.actions != after.actions {
        fields.push("actions".into());
    }
    if before.bounds != after.bounds {
        fields.push("bounds".into());
    }
    fields
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum TreeError {
    #[error("accessibility tree is empty")]
    EmptyTree,
    #[error("accessibility tree contains duplicate platform node keys")]
    DuplicateNodeKey,
    #[error("accessibility tree must contain exactly one root, found {0}")]
    RootCount(usize),
    #[error("node {0:?} is its own parent")]
    SelfParent(NodeKey),
    #[error("node {node:?} refers to missing parent {parent:?}")]
    MissingParent { node: NodeKey, parent: NodeKey },
    #[error("node {0:?} participates in a parent cycle")]
    ParentCycle(NodeKey),
    #[error("element ID space is exhausted")]
    IdExhausted,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(key: &str, parent: Option<&str>, index: u32, role: &str, name: &str) -> AccessibleNode {
        AccessibleNode {
            key: NodeKey(key.into()),
            parent: parent.map(|value| NodeKey(value.into())),
            index_in_parent: index,
            role: role.into(),
            name: name.into(),
            description: String::new(),
            value: None,
            states: vec!["showing".into()],
            actions: Vec::new(),
            bounds: None,
        }
    }

    #[test]
    fn first_update_is_full_and_ids_are_stable() {
        let mut engine = TreeDiffEngine::new();
        let first = engine
            .update(
                TreeSnapshot {
                    nodes: vec![
                        node("root", None, 0, "application", "Editor"),
                        node("save", Some("root"), 0, "button", "Save"),
                    ],
                },
                false,
            )
            .unwrap();
        assert_eq!(first.kind, TreeUpdateKind::Full);
        assert_eq!(first.current[1].element_index, ElementId(2));

        let second = engine
            .update(
                TreeSnapshot {
                    nodes: vec![
                        node("root", None, 0, "application", "Editor"),
                        node("save", Some("root"), 0, "button", "Save document"),
                    ],
                },
                false,
            )
            .unwrap();
        assert_eq!(second.kind, TreeUpdateKind::Diff);
        assert_eq!(second.current[1].element_index, ElementId(2));
        assert_eq!(second.changes.len(), 1);
        assert_eq!(second.changes[0].kind, ChangeKind::Updated);
        assert_eq!(second.changes[0].changed_fields, vec!["name"]);
    }

    #[test]
    fn removed_ids_are_never_reused() {
        let mut engine = TreeDiffEngine::new();
        engine
            .update(
                TreeSnapshot {
                    nodes: vec![
                        node("root", None, 0, "application", "Editor"),
                        node("old", Some("root"), 0, "button", "Old"),
                    ],
                },
                false,
            )
            .unwrap();
        let removal = engine
            .update(
                TreeSnapshot {
                    nodes: vec![node("root", None, 0, "application", "Editor")],
                },
                false,
            )
            .unwrap();
        assert_eq!(removal.changes[0].kind, ChangeKind::Removed);
        assert_eq!(removal.changes[0].element_index, ElementId(2));

        let addition = engine
            .update(
                TreeSnapshot {
                    nodes: vec![
                        node("root", None, 0, "application", "Editor"),
                        node("new", Some("root"), 0, "button", "New"),
                    ],
                },
                false,
            )
            .unwrap();
        assert_eq!(addition.current[1].element_index, ElementId(3));

        let removed_again = engine
            .update(
                TreeSnapshot {
                    nodes: vec![node("root", None, 0, "application", "Editor")],
                },
                false,
            )
            .unwrap();
        assert_eq!(removed_again.changes[0].element_index, ElementId(3));
        let same_key_reappears = engine
            .update(
                TreeSnapshot {
                    nodes: vec![
                        node("root", None, 0, "application", "Editor"),
                        node("new", Some("root"), 0, "button", "Replacement"),
                    ],
                },
                false,
            )
            .unwrap();
        assert_eq!(same_key_reappears.current[1].element_index, ElementId(4));
    }

    #[test]
    fn disable_diff_returns_full_but_updates_baseline() {
        let mut engine = TreeDiffEngine::new();
        engine
            .update(
                TreeSnapshot {
                    nodes: vec![node("root", None, 0, "application", "One")],
                },
                false,
            )
            .unwrap();
        let full = engine
            .update(
                TreeSnapshot {
                    nodes: vec![node("root", None, 0, "application", "Two")],
                },
                true,
            )
            .unwrap();
        assert_eq!(full.kind, TreeUpdateKind::Full);

        let no_changes = engine
            .update(
                TreeSnapshot {
                    nodes: vec![node("root", None, 0, "application", "Two")],
                },
                false,
            )
            .unwrap();
        assert!(no_changes.changes.is_empty());
    }

    #[test]
    fn rejects_nodes_with_missing_parents() {
        let snapshot = TreeSnapshot {
            nodes: vec![
                node("root", None, 0, "application", "Editor"),
                node("orphan", Some("missing"), 0, "button", "No parent"),
            ],
        };
        assert!(matches!(
            snapshot.validate(),
            Err(TreeError::MissingParent { .. })
        ));
    }

    #[test]
    fn rejects_disconnected_parent_cycles() {
        let snapshot = TreeSnapshot {
            nodes: vec![
                node("root", None, 0, "application", "Editor"),
                node("a", Some("b"), 0, "panel", "A"),
                node("b", Some("a"), 0, "panel", "B"),
            ],
        };
        assert!(matches!(
            snapshot.validate(),
            Err(TreeError::ParentCycle(_))
        ));
    }
}
