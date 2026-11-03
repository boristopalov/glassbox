//! The HTTP routes the UI calls, driven through the router without a socket.

use axum::body::Body;
use axum::http::{Request, StatusCode};
use glassbox::engine::{Config, Engine};
use glassbox::server::router;
use http_body_util::BodyExt;
use parking_lot::Mutex;
use serde_json::Value;
use std::sync::Arc;
use tower::ServiceExt;

/// The probe is process-wide, so tests that record a run take turns.
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn app() -> axum::Router {
    let engine = Engine::open(Config {
        frames: 16,
        dir: None,
        sort_budget_bytes: 64 * 1024,
        demo: false,
    })
    .expect("empty engine opens");
    router(Arc::new(Mutex::new(engine)))
}

async fn send(app: &axum::Router, req: Request<Body>) -> (StatusCode, Vec<u8>) {
    let res = app.clone().oneshot(req).await.expect("router answers");
    let status = res.status();
    let body = res
        .into_body()
        .collect()
        .await
        .expect("body reads")
        .to_bytes();
    (status, body.to_vec())
}

async fn run(app: &axum::Router, sql: &str) -> Value {
    let body = serde_json::json!({ "sql": sql, "batch": 2 }).to_string();
    let req = Request::post("/api/run")
        .header("content-type", "application/json")
        .body(Body::from(body))
        .expect("request builds");
    let (status, bytes) = send(app, req).await;
    assert_eq!(status, StatusCode::OK);
    serde_json::from_slice(&bytes).expect("run answers json")
}

#[tokio::test]
async fn the_page_and_its_assets_are_served() {
    let _turn = SERIAL.lock().await;
    let app = app();
    for (path, needle) in [
        ("/", "GLASS"),
        ("/app.js", "createScene"),
        ("/scene.js", "WebGLRenderer"),
        ("/style.css", "--cyan"),
        ("/vendor/three/three.module.min.js", "WebGLRenderer"),
        ("/vendor/three/LICENSE", "MIT"),
    ] {
        let (status, body) = send(&app, Request::get(path).body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(
            String::from_utf8_lossy(&body).contains(needle),
            "{path} holds {needle}"
        );
    }
}

/// Follows every `import ... from "..."` starting at app.js, resolving bare names through the
/// page's import map, so a missing vendored file fails here instead of in the browser.
#[tokio::test]
async fn every_module_the_page_imports_is_served() {
    let _turn = SERIAL.lock().await;
    let app = app();
    let (_, html) = send(&app, Request::get("/").body(Body::empty()).unwrap()).await;
    let html = String::from_utf8_lossy(&html).into_owned();
    let mut pending = vec!["/app.js".to_string()];
    let mut seen = std::collections::HashSet::new();
    while let Some(path) = pending.pop() {
        if !seen.insert(path.clone()) {
            continue;
        }
        let (status, body) = send(
            &app,
            Request::get(path.as_str()).body(Body::empty()).unwrap(),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{path}");
        let src = String::from_utf8_lossy(&body).into_owned();
        for spec in imports(&src) {
            pending.push(resolve(&path, &spec, &html));
        }
    }
    assert!(seen.contains("/vendor/three/three.module.min.js"));
    assert!(seen.contains("/vendor/three/addons/shaders/CopyShader.js"));
}

fn imports(src: &str) -> Vec<String> {
    src.split(" from ")
        .skip(1)
        .filter_map(|rest| {
            let quote = rest.chars().next().filter(|c| *c == '"' || *c == '\'')?;
            rest[1..].split(quote).next().map(str::to_string)
        })
        .collect()
}

fn resolve(from: &str, spec: &str, html: &str) -> String {
    let dir = from.rsplit_once('/').map_or("", |(d, _)| d);
    if let Some(rel) = spec.strip_prefix("./") {
        return format!("{dir}/{rel}");
    }
    if let Some(rel) = spec.strip_prefix("../") {
        let up = dir.rsplit_once('/').map_or("", |(d, _)| d);
        return format!("{up}/{rel}");
    }
    let entry = |key: &str| {
        let needle = format!("\"{key}\": \"");
        html.split(&needle)
            .nth(1)
            .and_then(|r| r.split('"').next())
            .map(str::to_string)
    };
    if spec == "three" {
        return entry("three").expect("the import map names three");
    }
    let rest = spec
        .strip_prefix("three/addons/")
        .unwrap_or_else(|| panic!("{from} imports {spec}, which the import map does not cover"));
    format!(
        "{}{rest}",
        entry("three/addons/").expect("the import map names three/addons/")
    )
}

#[tokio::test]
async fn a_run_returns_plans_outcomes_and_a_trace() {
    let _turn = SERIAL.lock().await;
    let app = app();
    let run = run(
        &app,
        "CREATE TABLE t (a INT); INSERT INTO t VALUES (1), (2), (3); SELECT a FROM t WHERE a > 1;",
    )
    .await;
    let statements = run["statements"].as_array().expect("statements");
    assert_eq!(statements.len(), 3);
    let select = &statements[2];
    assert_eq!(select["outcome"]["kind"], "rows");
    assert_eq!(select["outcome"]["total"], 2);
    assert_eq!(select["plan"]["op"], "Project");
    let events = run["events"].as_array().expect("events");
    assert!(
        events.iter().any(|e| e["k"] == "batch"),
        "rows stream as batches"
    );
    assert!(
        events.iter().any(|e| e["k"] == "hit" || e["k"] == "load"),
        "pages are touched"
    );
    assert_eq!(run["truncated"], false);
}

#[tokio::test]
async fn state_lists_tables_and_examples() {
    let _turn = SERIAL.lock().await;
    let app = app();
    run(&app, "CREATE TABLE t (a INT);").await;
    let (status, body) = send(
        &app,
        Request::get("/api/state").body(Body::empty()).unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let state: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(state["frames"], 16);
    assert!(state["examples"].as_array().is_some_and(|e| !e.is_empty()));
    assert!(state["tables"].to_string().contains("\"t\""));
}
