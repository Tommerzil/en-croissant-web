use std::path::{Component, Path, PathBuf};

use crate::app::ApiError;

/// Map a client-supplied virtual path (rooted at "/") onto the data directory.
/// Any `..` component, NUL byte, or absolute-path escape is rejected.
pub fn resolve(data_dir: &Path, client: &str) -> Result<PathBuf, ApiError> {
    if client.contains('\0') {
        return Err(ApiError("invalid path".into()));
    }
    let mut out = data_dir.to_path_buf();
    for comp in Path::new(client).components() {
        match comp {
            Component::Normal(part) => out.push(part),
            Component::CurDir | Component::RootDir => {}
            Component::ParentDir | Component::Prefix(_) => {
                return Err(ApiError(format!("path escapes data dir: {client}")));
            }
        }
    }
    debug_assert!(out.starts_with(data_dir));
    Ok(out)
}

pub fn resolve_all(data_dir: &Path, clients: &[String]) -> Result<Vec<PathBuf>, ApiError> {
    clients.iter().map(|c| resolve(data_dir, c)).collect()
}

/// Engines are the only paths that get executed, so they must live under
/// `engines/` and be an existing regular file.
pub fn resolve_engine(data_dir: &Path, client: &str) -> Result<PathBuf, ApiError> {
    let path = resolve(data_dir, client)?;
    let engines = data_dir.join("engines");
    if !path.starts_with(&engines) || path == engines {
        return Err(ApiError(format!("engine must be under /engines: {client}")));
    }
    match std::fs::metadata(&path) {
        Ok(m) if m.is_file() => Ok(path),
        _ => Err(ApiError(format!("engine not found: {client}"))),
    }
}

/// Inverse of `resolve`, used when listing directories back to the client.
pub fn to_virtual(data_dir: &Path, real: &Path) -> String {
    match real.strip_prefix(data_dir) {
        Ok(rel) if rel.as_os_str().is_empty() => "/".to_string(),
        Ok(rel) => format!("/{}", rel.to_string_lossy().replace('\\', "/")),
        Err(_) => "/".to_string(),
    }
}
