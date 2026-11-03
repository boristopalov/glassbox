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
        ("/app.js", "function"),
        ("/style.css", "--cyan"),
    ] {
        let (status, body) = send(&app, Request::get(path).body(Body::empty()).unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{path}");
        assert!(
            String::from_utf8_lossy(&body).contains(needle),
            "{path} holds {needle}"
        );
    }
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
