use std::path::Path;

use chess_server::paths::{resolve, resolve_engine, to_virtual};

fn root() -> &'static Path {
    Path::new("/srv/chess")
}

#[test]
fn accepts_common_spellings() {
    for p in ["/db/a.db3", "db/a.db3", "./db/a.db3", "//db//a.db3"] {
        assert_eq!(resolve(root(), p).unwrap(), Path::new("/srv/chess/db/a.db3"), "{p}");
    }
}

#[test]
fn root_itself_is_allowed() {
    assert_eq!(resolve(root(), "/").unwrap(), root());
    assert_eq!(resolve(root(), "").unwrap(), root());
}

#[test]
fn rejects_traversal_and_nul() {
    for p in ["../etc/passwd", "db/../../x", "/db/..", "db/\0x"] {
        assert!(resolve(root(), p).is_err(), "{p}");
    }
}

#[test]
fn virtual_roundtrip() {
    let real = resolve(root(), "/db/a.db3").unwrap();
    assert_eq!(to_virtual(root(), &real), "/db/a.db3");
    assert_eq!(to_virtual(root(), root()), "/");
}

#[test]
fn engine_must_be_regular_file_under_engines() {
    let tmp = tempfile::TempDir::new().unwrap();
    let engines = tmp.path().join("engines");
    std::fs::create_dir_all(&engines).unwrap();
    std::fs::write(engines.join("stockfish"), b"#!/bin/sh\n").unwrap();
    std::fs::write(tmp.path().join("db").join("x"), b"").ok();
    std::fs::create_dir_all(tmp.path().join("db")).unwrap();
    std::fs::write(tmp.path().join("db/notengine"), b"").unwrap();

    assert!(resolve_engine(tmp.path(), "engines/stockfish").is_ok());
    assert!(resolve_engine(tmp.path(), "/engines/stockfish").is_ok());
    assert!(resolve_engine(tmp.path(), "db/notengine").is_err(), "outside engines/");
    assert!(resolve_engine(tmp.path(), "engines/missing").is_err(), "must exist");
    assert!(resolve_engine(tmp.path(), "engines").is_err(), "directory, not file");
}
