// fsops.rs — explorer-style file operations on real filesystem paths.
//
// Deliberately small: delete to the recycle bin, rename, move to another
// folder, create a folder, open with the OS default app. No permanent delete,
// no clipboard, and archives stay read-only — the frontend never sends zip
// entries here. Every operation refuses to overwrite an existing file.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
pub struct FsFailure {
    pub path: String,
    pub error: String,
}

/// Per-item outcome of a batch operation (`ok` succeeded, `failed` did not).
#[derive(Serialize)]
pub struct FsReport {
    pub ok: usize,
    pub failed: Vec<FsFailure>,
}

/// A bare file/folder name: non-empty, not `.`/`..`, no separators, and none
/// of the characters Windows forbids (the strictest platform, so names stay
/// portable across the OSes glasspane runs on).
fn validate_name(name: &str) -> Result<&str, String> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." {
        return Err("name is empty or invalid".into());
    }
    if n.chars().any(|c| {
        matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
    }) {
        return Err(r#"name contains a character that is not allowed: \ / : * ? " < > |"#.into());
    }
    Ok(n)
}

/// Move files/folders to the OS recycle bin / trash (recoverable).
#[tauri::command]
pub fn trash_paths(paths: Vec<String>) -> FsReport {
    let mut report = FsReport {
        ok: 0,
        failed: Vec::new(),
    };
    for path in paths {
        match trash::delete(&path) {
            Ok(()) => report.ok += 1,
            Err(e) => report.failed.push(FsFailure {
                path,
                error: e.to_string(),
            }),
        }
    }
    report
}

/// Rename `path` in place to `new_name`; returns the new full path.
#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let new_name = validate_name(&new_name)?;
    let src = Path::new(&path);
    let parent = src.parent().ok_or("path has no parent folder")?;
    let dest = parent.join(new_name);
    if dest == src {
        return Ok(path);
    }
    // Case-only renames (a.jpg → A.jpg) look like an existing target on
    // case-insensitive filesystems; let those through.
    let case_only = src
        .file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.eq_ignore_ascii_case(new_name));
    if dest.exists() && !case_only {
        return Err(format!("'{new_name}' already exists"));
    }
    fs::rename(src, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Move each path into `dest_dir` (same name). Same-volume moves are a
/// rename; across volumes it copies then removes the source.
#[tauri::command]
pub fn move_paths(paths: Vec<String>, dest_dir: String) -> FsReport {
    let dest_dir = PathBuf::from(dest_dir);
    let mut report = FsReport {
        ok: 0,
        failed: Vec::new(),
    };
    for path in paths {
        match move_one(Path::new(&path), &dest_dir) {
            Ok(_) => report.ok += 1,
            Err(error) => report.failed.push(FsFailure { path, error }),
        }
    }
    report
}

fn move_one(src: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    if !dest_dir.is_dir() {
        return Err("destination is not a folder".into());
    }
    let name = src.file_name().ok_or("path has no file name")?;
    if src.parent() == Some(dest_dir) {
        return Err("already in that folder".into());
    }
    let dest = dest_dir.join(name);
    if dest.exists() {
        return Err("a file with that name already exists in the destination".into());
    }
    if fs::rename(src, &dest).is_ok() {
        return Ok(dest);
    }
    // rename fails across volumes/devices — fall back to copy + delete
    fs::copy(src, &dest).map_err(|e| e.to_string())?;
    fs::remove_file(src).map_err(|e| e.to_string())?;
    Ok(dest)
}

/// Create `parent/name`; errors if it already exists. Returns the new path.
#[tauri::command]
pub fn create_dir(parent: String, name: String) -> Result<String, String> {
    let name = validate_name(&name)?;
    let dest = Path::new(&parent).join(name);
    fs::create_dir(&dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Open the file with the OS default application (image editor, etc.).
#[tauri::command]
pub fn open_with_default(path: String) -> Result<(), String> {
    open::that_detached(&path).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests — real filesystem operations in a scratch dir under the OS temp dir
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("glasspane-fsops-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn s(p: &Path) -> String {
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn name_validation() {
        assert!(validate_name("").is_err());
        assert!(validate_name("   ").is_err());
        assert!(validate_name(".").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name("a:b").is_err());
        assert!(validate_name("what?").is_err());
        assert_eq!(validate_name("  photo 01.jpg ").unwrap(), "photo 01.jpg");
        assert_eq!(validate_name("한글 이름.webp").unwrap(), "한글 이름.webp");
    }

    #[test]
    fn rename_in_place_and_refuse_overwrite() {
        let d = scratch("rename");
        fs::write(d.join("a.jpg"), b"a").unwrap();
        fs::write(d.join("b.jpg"), b"b").unwrap();

        let new = rename_path(s(&d.join("a.jpg")), "c.jpg".into()).unwrap();
        assert_eq!(Path::new(&new), d.join("c.jpg"));
        assert!(!d.join("a.jpg").exists() && d.join("c.jpg").exists());

        // no clobbering
        let err = rename_path(s(&d.join("c.jpg")), "b.jpg".into()).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        assert_eq!(fs::read(d.join("b.jpg")).unwrap(), b"b");

        // same name is a no-op, bad names are rejected before touching disk
        assert_eq!(
            rename_path(s(&d.join("c.jpg")), "c.jpg".into()).unwrap(),
            s(&d.join("c.jpg"))
        );
        assert!(rename_path(s(&d.join("c.jpg")), "x/y.jpg".into()).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn move_into_folder_and_refuse_collisions() {
        let d = scratch("move");
        let dest = d.join("dest");
        fs::create_dir(&dest).unwrap();
        fs::write(d.join("a.jpg"), b"a").unwrap();
        fs::write(d.join("b.jpg"), b"b").unwrap();
        fs::write(dest.join("b.jpg"), b"old").unwrap(); // collision for b

        let r = move_paths(vec![s(&d.join("a.jpg")), s(&d.join("b.jpg"))], s(&dest));
        assert_eq!(r.ok, 1);
        assert_eq!(r.failed.len(), 1);
        assert!(r.failed[0].path.ends_with("b.jpg"));
        assert!(dest.join("a.jpg").exists() && !d.join("a.jpg").exists());
        assert_eq!(fs::read(dest.join("b.jpg")).unwrap(), b"old"); // untouched
        assert!(d.join("b.jpg").exists()); // source kept on failure

        // moving into its own folder / into a non-folder is an error, not a no-op that deletes
        let r = move_paths(vec![s(&dest.join("a.jpg"))], s(&dest));
        assert_eq!(r.failed.len(), 1);
        let r = move_paths(vec![s(&dest.join("a.jpg"))], s(&dest.join("b.jpg")));
        assert_eq!(r.failed.len(), 1);
        assert!(dest.join("a.jpg").exists());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn create_dir_once() {
        let d = scratch("mkdir");
        let p = create_dir(s(&d), "new folder".into()).unwrap();
        assert!(Path::new(&p).is_dir());
        assert!(create_dir(s(&d), "new folder".into()).is_err()); // exists
        assert!(create_dir(s(&d), "bad:name".into()).is_err());
        let _ = fs::remove_dir_all(&d);
    }

    #[test]
    fn trash_reports_per_item() {
        let d = scratch("trash");
        fs::write(d.join("gone.jpg"), b"x").unwrap();
        let r = trash_paths(vec![
            s(&d.join("gone.jpg")),
            s(&d.join("never-existed.jpg")),
        ]);
        // the missing file must be reported, never silently counted as ok
        assert_eq!(r.failed.len(), 1);
        assert!(r.failed[0].path.ends_with("never-existed.jpg"));
        if r.ok == 1 {
            assert!(!d.join("gone.jpg").exists(), "trashed file still on disk");
        }
        let _ = fs::remove_dir_all(&d);
    }
}
