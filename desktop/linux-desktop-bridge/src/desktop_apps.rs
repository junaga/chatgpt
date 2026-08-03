//! Freedesktop desktop-entry discovery and safe argv-based launching.

use std::{
    collections::HashSet,
    env, fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use thiserror::Error;

use crate::protocol::AppInfo;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopApp {
    pub info: AppInfo,
    pub desktop_file: PathBuf,
}

pub fn discover() -> Vec<DesktopApp> {
    let mut apps = Vec::new();
    for directory in application_directories() {
        discover_directory(&directory, &directory, &mut apps);
    }
    let mut seen = HashSet::new();
    apps.retain(|app| seen.insert(app.info.id.to_ascii_lowercase()));
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
    apps
}

pub fn resolve(query: &str) -> Result<DesktopApp, DesktopAppError> {
    resolve_from(query, &discover())
}

/// Launch through freedesktop-aware tools with explicit argv. No shell or
/// desktop-entry `Exec` string is interpreted by this process.
pub fn launch(app: &DesktopApp) -> Result<(), DesktopAppError> {
    match Command::new("gio")
        .arg("launch")
        .arg(&app.desktop_file)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
    {
        Ok(status) if status.success() => return Ok(()),
        Ok(_) | Err(_) => {}
    }
    let status = Command::new("gtk-launch")
        .arg(&app.info.id)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|error| DesktopAppError::Launch(error.to_string()))?;
    if status.success() {
        Ok(())
    } else {
        Err(DesktopAppError::Launch(format!(
            "gio launch and gtk-launch both failed for {}",
            app.info.id
        )))
    }
}

fn application_directories() -> Vec<PathBuf> {
    let mut directories = Vec::new();
    if let Some(data_home) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        directories.push(PathBuf::from(data_home).join("applications"));
    } else if let Some(home) = env::var_os("HOME").filter(|value| !value.is_empty()) {
        directories.push(PathBuf::from(home).join(".local/share/applications"));
    }
    let data_dirs = env::var_os("XDG_DATA_DIRS")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    directories.extend(env::split_paths(&data_dirs).map(|path| path.join("applications")));
    directories
}

fn discover_directory(root: &Path, directory: &Path, apps: &mut Vec<DesktopApp>) {
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            discover_directory(root, &path, apps);
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("desktop") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        let Some(name) = parse_desktop_entry_name(&contents) else {
            continue;
        };
        let Ok(relative) = path.strip_prefix(root) else {
            continue;
        };
        let id = relative
            .to_string_lossy()
            .trim_end_matches(".desktop")
            .replace(std::path::MAIN_SEPARATOR, "-");
        apps.push(DesktopApp {
            info: AppInfo {
                id,
                display_name: Some(name),
                is_running: Some(false),
                last_used_date: None,
                use_count: None,
            },
            desktop_file: path,
        });
    }
}

fn parse_desktop_entry_name(contents: &str) -> Option<String> {
    let mut in_entry = false;
    let mut is_application = false;
    let mut name = None;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            in_entry = line == "[Desktop Entry]";
            continue;
        }
        if !in_entry || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        match key {
            "Type" => is_application = value == "Application",
            "Hidden" if value.eq_ignore_ascii_case("true") => return None,
            "NoDisplay" if value.eq_ignore_ascii_case("true") => return None,
            "Name" if !value.trim().is_empty() => name = Some(value.trim().to_owned()),
            _ => {}
        }
    }
    is_application.then_some(name).flatten()
}

fn resolve_from(query: &str, apps: &[DesktopApp]) -> Result<DesktopApp, DesktopAppError> {
    let query = query.trim();
    let matches: Vec<_> = apps
        .iter()
        .filter(|app| {
            app.info.id.eq_ignore_ascii_case(query)
                || format!("{}.desktop", app.info.id).eq_ignore_ascii_case(query)
                || app.desktop_file.to_string_lossy().eq_ignore_ascii_case(query)
                || app
                    .info
                    .display_name
                    .as_deref()
                    .is_some_and(|name| name.eq_ignore_ascii_case(query))
        })
        .cloned()
        .collect();
    match matches.as_slice() {
        [app] => Ok(app.clone()),
        [] => Err(DesktopAppError::NotFound(query.into())),
        _ => Err(DesktopAppError::Ambiguous(query.into())),
    }
}

#[derive(Debug, Error)]
pub enum DesktopAppError {
    #[error("installed desktop application was not found: {0}")]
    NotFound(String),
    #[error("installed desktop application name is ambiguous: {0}")]
    Ambiguous(String),
    #[error("failed to launch desktop application: {0}")]
    Launch(String),
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str, path: &str) -> DesktopApp {
        DesktopApp {
            info: AppInfo {
                id: id.into(),
                display_name: Some(name.into()),
                is_running: Some(false),
                last_used_date: None,
                use_count: None,
            },
            desktop_file: path.into(),
        }
    }

    #[test]
    fn parses_only_visible_application_entries() {
        assert_eq!(
            parse_desktop_entry_name("[Desktop Entry]\nType=Application\nName=Editor\n"),
            Some("Editor".into())
        );
        assert_eq!(
            parse_desktop_entry_name(
                "[Desktop Entry]\nType=Application\nName=Hidden\nNoDisplay=true\n"
            ),
            None
        );
    }

    #[test]
    fn resolves_id_desktop_suffix_display_name_and_scanned_path() {
        let apps = [app("org.example.Editor", "Editor", "/usr/share/applications/org.example.Editor.desktop")];
        for query in [
            "org.example.Editor",
            "org.example.Editor.desktop",
            "Editor",
            "/usr/share/applications/org.example.Editor.desktop",
        ] {
            assert_eq!(resolve_from(query, &apps).unwrap().info.id, "org.example.Editor");
        }
    }

    #[test]
    fn duplicate_display_names_are_ambiguous() {
        let apps = [
            app("one", "Editor", "/apps/one.desktop"),
            app("two", "Editor", "/apps/two.desktop"),
        ];
        assert!(matches!(
            resolve_from("Editor", &apps),
            Err(DesktopAppError::Ambiguous(_))
        ));
    }
}
