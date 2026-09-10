#!/usr/bin/env python3
"""Generate server/src/routes_gen.rs from the command signatures in ../src-tauri/src.

One axum handler per `#[cfg_attr(feature = "tauri", tauri::command)]` function in the
files that compile under the `server` feature. Argument names are camelCased in JSON,
matching Tauri's convention and the generated frontend bindings.
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass, field
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "src-tauri" / "src"
OUT = Path(__file__).resolve().parent / "src" / "routes_gen.rs"

# Files compiled only under the `tauri` feature, or with no surviving commands.
SKIP_FILES = {"main.rs", "lib.rs", "ctx.rs", "oauth.rs", "puzzle.rs", "sound.rs"}
# Commands gated with #[cfg(feature = "tauri")] or replaced by hand-written routes.
# Hand-written because a client path is nested inside a struct argument, which the
# generator cannot jail: analyze_game (`options.reference_db`) and start_game
# (`config.white`/`config.black` engine binaries and `config.openingBook.path`).
SKIP_FNS = {"download_file", "set_file_as_executable", "close_splashscreen",
            "memory_size", "is_bmi2_compatible", "get_sound_server_port", "authenticate",
            "analyze_game", "start_game"}
# Commands whose future only completes when the engine process exits. They are run in a
# detached task; the handler returns the early result if it arrives within the grace period.
SPAWN_FNS = {"get_best_moves"}
SPAWN_GRACE_MS = 300
# String parameters that carry a filesystem path.
PATH_STRINGS = {("write_game", "file_path"), ("file_exists", "path"), ("get_file_metadata", "path")}
# String parameters whose name looks path-like but which are not filesystem paths.
# Empty today; add (fn, param) entries here (with a reason) if upstream introduces one.
NON_PATH_STRINGS: set[tuple[str, str]] = set()
# Names that make a String/&str parameter suspect of being a filesystem path.
PATHY_NAME_RE = re.compile(r"(^|_)(path|file|dir|db|database|destination)(_|$)")
# Parameters that carry the client's tab id (drive the idle reaper's last_seen map).
TAB_PARAMS = {"tab", "tab_id"}
# Struct arguments with a client path somewhere in their fields. The generator jails
# whole parameters, not fields, so a command taking one must be hand-written in
# routes_extra.rs (and listed in SKIP_FNS); seeing one here is a bug, not a case to
# handle. Add a type here whenever a command argument grows a nested path. Matched as a
# substring of the type, so `Option<GameConfig>` and `Vec<GameConfig>` are caught too.
NESTED_PATH_TYPES = {"AnalysisOptions", "GameConfig"}
# Parameters that name an engine binary (must resolve under engines/).
ENGINE_PARAMS = {("get_best_moves", "engine"), ("analyze_game", "engine"), ("get_engine_config", "path")}

ATTR = '#[cfg_attr(feature = "tauri", tauri::command)]'
FN_RE = re.compile(r"pub\s+(async\s+)?fn\s+(\w+)\s*\((.*?)\)\s*(->\s*(.*?))?\s*\{", re.S)


@dataclass
class Param:
    name: str
    ty: str
    kind: str  # plain | str_ref | path | paths | path_string | engine_string | engine_path | ctx | state


@dataclass
class Command:
    name: str
    module: str
    is_async: bool
    returns_result: bool
    params: list[Param] = field(default_factory=list)


def split_params(raw: str) -> list[str]:
    out, depth, cur = [], 0, ""
    for ch in raw:
        if ch in "<([":
            depth += 1
        elif ch in ">)]":
            depth -= 1
        if ch == "," and depth == 0:
            out.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        out.append(cur.strip())
    return [p for p in out if p]


def classify(fn: str, name: str, ty: str) -> str:
    if ty.startswith("AppCtx"):
        return "ctx"
    if ty.startswith("AppStateRef"):
        return "state"
    if any(nested in ty for nested in NESTED_PATH_TYPES):
        raise SystemExit(
            f"{fn}.{name}: {ty} nests a client path the generator cannot jail; "
            "hand-write the route in routes_extra.rs and add the command to SKIP_FNS"
        )
    if (fn, name) in ENGINE_PARAMS:
        return "engine_path" if ty == "PathBuf" else "engine_string"
    if ty == "PathBuf":
        return "path"
    if ty == "Vec<PathBuf>":
        return "paths"
    if (fn, name) in PATH_STRINGS:
        return "path_string"
    if ty == "&str":
        kind = "str_ref"
    else:
        kind = "plain"
    # Fail closed: never ship an unjailed path out of the generator.
    if "Path" in ty:
        raise SystemExit(f"unhandled path-typed param {fn}.{name}: {ty}")
    if ty in ("String", "&str") and PATHY_NAME_RE.search(name) and (fn, name) not in NON_PATH_STRINGS:
        raise SystemExit(f"unhandled path-typed param {fn}.{name}: {ty}")
    return kind


def parse_commands(source: str, module: str) -> list[Command]:
    cmds = []
    idx = 0
    while True:
        idx = source.find(ATTR, idx)
        if idx < 0:
            break
        m = FN_RE.search(source, idx)
        if not m:
            break
        is_async, name, raw_params, _, ret = m.groups()
        idx = m.end()
        if name in SKIP_FNS:
            continue
        params = []
        for p in split_params(raw_params):
            pname, pty = [s.strip() for s in p.split(":", 1)]
            params.append(Param(pname, pty, classify(name, pname, pty)))
        cmds.append(Command(
            name=name,
            module=module,
            is_async=bool(is_async),
            returns_result=(ret or "").strip().startswith("Result<"),
            params=params,
        ))
    return cmds


def camel(s: str) -> str:
    head, *rest = s.split("_")
    return head + "".join(w.capitalize() for w in rest)


def pascal(s: str) -> str:
    return "".join(w.capitalize() for w in s.split("_"))


def json_field_type(p: Param) -> str:
    if p.kind in ("path", "path_string", "engine_string", "engine_path", "str_ref"):
        return "String"
    if p.kind == "paths":
        return "Vec<String>"
    return p.ty


def call_arg(p: Param) -> str:
    return {
        "ctx": "app.ctx.clone()",
        "state": "&*app.ctx.state",
        "path": f"resolve(&app.ctx.data_dir, &args.{p.name})?",
        "paths": f"resolve_all(&app.ctx.data_dir, &args.{p.name})?",
        "path_string": f"resolve(&app.ctx.data_dir, &args.{p.name})?.to_string_lossy().into_owned()",
        "engine_string": f"resolve_engine(&app.ctx.data_dir, &args.{p.name})?.to_string_lossy().into_owned()",
        "engine_path": f"resolve_engine(&app.ctx.data_dir, &args.{p.name})?",
        "str_ref": f"&args.{p.name}",
        "plain": f"args.{p.name}",
    }[p.kind]


def render_command(c: Command) -> str:
    json_params = [p for p in c.params if p.kind not in ("ctx", "state")]
    struct_name = f"{pascal(c.name)}Args"
    lines = ["#[derive(Deserialize)]", '#[serde(rename_all = "camelCase")]', f"pub struct {struct_name} {{"]
    for p in json_params:
        lines.append(f"    pub {p.name}: {json_field_type(p)},")
    lines.append("}")
    lines.append("")
    lines.append(f"pub async fn {c.name}(State(app): State<App>, Json(args): Json<{struct_name}>) -> ApiResult {{")
    if not json_params:
        lines.append("    let _ = &args;")
    for p in json_params:
        if p.name in TAB_PARAMS:
            lines.append(f"    app.touch_tab(&args.{p.name});")
    call = f"en_croissant::{c.module}::{c.name}({', '.join(call_arg(p) for p in c.params)})"
    if c.name in SPAWN_FNS:
        # Resolve jailed args eagerly (so a bad path is a 500 now), then detach.
        pre = [p for p in c.params if p.kind not in ("ctx", "state", "plain", "str_ref")]
        for p in pre:
            lines.append(f"    let {p.name} = {call_arg(p)};")
        detached_args = []
        for p in c.params:
            if p.kind in ("ctx",):
                detached_args.append("app2.ctx.clone()")
            elif p.kind == "state":
                detached_args.append("&*app2.ctx.state")
            elif p.kind == "str_ref":
                detached_args.append(f"&args.{p.name}")
            elif p.kind == "plain":
                detached_args.append(f"args.{p.name}")
            else:
                detached_args.append(p.name)
        inner = f"en_croissant::{c.module}::{c.name}({', '.join(detached_args)}).await"
        lines.append("    let app2 = app.clone();")
        lines.append(f"    let handle = tokio::spawn(async move {{ {inner} }});")
        lines.append(f"    match tokio::time::timeout(std::time::Duration::from_millis({SPAWN_GRACE_MS}), handle).await {{")
        lines.append("        Ok(Ok(Ok(out))) => Ok(Json(serde_json::to_value(out)?)),")
        lines.append("        Ok(Ok(Err(e))) => Err(e.into()),")
        lines.append("        Ok(Err(join)) => Err(crate::app::ApiError(join.to_string())),")
        lines.append("        Err(_elapsed) => Ok(Json(serde_json::Value::Null)), // still running; results arrive as events")
        lines.append("    }")
        lines.append("}")
        lines.append("")
        return "\n".join(lines)
    if c.is_async:
        call += ".await"
    if c.returns_result:
        call += "?"
    lines.append(f"    let out = {call};")
    lines.append("    Ok(Json(serde_json::to_value(out)?))")
    lines.append("}")
    lines.append("")
    src = "\n".join(lines)
    # Unit-returning commands serialize to null; keep the marker the tests look for.
    if not c.returns_result and not c.is_async and c.name == "clear_games":
        src = src.replace("Ok(Json(serde_json::to_value(out)?))",
                          "let () = out;\n    Ok(Json(serde_json::Value::Null))")
    return src


def render_router(cmds: list[Command]) -> str:
    lines = ["pub fn router() -> Router<App> {", "    Router::new()"]
    for c in cmds:
        lines.append(f'        .route("/api/cmd/{c.name}", post({c.name}))')
    lines.append("}")
    return "\n".join(lines)


HEADER = '''//! GENERATED by server/gen_routes.py from ../src-tauri/src. Do not edit by hand.
#![allow(clippy::all, unused_imports, unused_variables, non_snake_case)]
use axum::extract::State;
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use std::path::PathBuf;

use en_croissant::chess::*;
use en_croissant::db::*;
use en_croissant::engine::*;
use en_croissant::lexer::*;
use en_croissant::opening::*;
use en_croissant::pgn::*;
use en_croissant::progress::*;
use en_croissant::fs::*;

use crate::app::{ApiResult, App};
use crate::paths::{resolve, resolve_all, resolve_engine};

'''


def module_of(path: Path) -> str:
    rel = path.relative_to(SRC).with_suffix("")
    parts = list(rel.parts)
    if parts[-1] == "mod":
        parts.pop()
    return parts[0]  # commands are re-exported from their top-level module


def main() -> int:
    cmds: list[Command] = []
    for path in sorted(SRC.rglob("*.rs")):
        if path.name in SKIP_FILES:
            continue
        cmds.extend(parse_commands(path.read_text(), module_of(path)))
    body = HEADER + "\n\n".join(render_command(c) for c in cmds) + "\n\n" + render_router(cmds) + "\n"
    OUT.write_text(body)
    print(f"wrote {OUT} with {len(cmds)} commands: {', '.join(c.name for c in cmds)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
