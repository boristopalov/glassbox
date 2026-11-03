//! The HTTP side: serves the UI and runs SQL for it.

use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use crate::demo::EXAMPLES;
use crate::engine::{Engine, Run};

const INDEX_HTML: &str = include_str!("../web/index.html");
const APP_JS: &str = include_str!("../web/app.js");
const STYLE_CSS: &str = include_str!("../web/style.css");
const SCENE_JS: &str = include_str!("../web/scene.js");

macro_rules! vendored {
    ($($path:literal),* $(,)?) => {
        &[$(($path, include_str!(concat!("../web/vendor/three/", $path)))),*]
    };
}

/// three.js and the few addons the scene uses, served from the binary so there is no build step.
const VENDOR: &[(&str, &str)] = vendored![
    "three.module.min.js",
    "LICENSE",
    "addons/controls/OrbitControls.js",
    "addons/postprocessing/EffectComposer.js",
    "addons/postprocessing/MaskPass.js",
    "addons/postprocessing/OutputPass.js",
    "addons/postprocessing/Pass.js",
    "addons/postprocessing/RenderPass.js",
    "addons/postprocessing/ShaderPass.js",
    "addons/postprocessing/UnrealBloomPass.js",
    "addons/shaders/CopyShader.js",
    "addons/shaders/LuminosityHighPassShader.js",
    "addons/shaders/OutputShader.js",
];

/// Rows per batch the UI starts with: small, so rows visibly stream between operators.
pub const DEFAULT_BATCH: usize = 64;

pub type Shared = Arc<Mutex<Engine>>;

#[derive(Deserialize)]
pub struct RunRequest {
    pub sql: String,
    #[serde(default)]
    pub batch: Option<usize>,
}

#[derive(Serialize)]
struct Example {
    label: &'static str,
    sql: &'static str,
}

#[derive(Serialize)]
struct StateResponse {
    #[serde(flatten)]
    state: crate::engine::State,
    examples: Vec<Example>,
    default_batch: usize,
    sort_budget_bytes: usize,
}

pub fn router(engine: Shared) -> Router {
    Router::new()
        .route("/", get(|| async { Html(INDEX_HTML) }))
        .route(
            "/app.js",
            get(|| async { asset("text/javascript; charset=utf-8", APP_JS) }),
        )
        .route(
            "/style.css",
            get(|| async { asset("text/css; charset=utf-8", STYLE_CSS) }),
        )
        .route(
            "/scene.js",
            get(|| async { asset("text/javascript; charset=utf-8", SCENE_JS) }),
        )
        .route("/vendor/three/{*path}", get(vendor))
        .route("/api/state", get(state))
        .route("/api/run", post(run))
        .route("/api/reset", post(reset))
        .with_state(engine)
}

async fn vendor(Path(path): Path<String>) -> Response {
    match VENDOR.iter().find(|(p, _)| *p == path) {
        Some((p, body)) if p.ends_with(".js") => asset("text/javascript; charset=utf-8", body),
        Some((_, body)) => asset("text/plain; charset=utf-8", body),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

fn asset(content_type: &'static str, body: &'static str) -> Response {
    (
        [
            (header::CONTENT_TYPE, content_type),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        body,
    )
        .into_response()
}

fn state_of(engine: &Engine) -> StateResponse {
    StateResponse {
        state: engine.state(),
        examples: EXAMPLES
            .iter()
            .map(|&(label, sql)| Example { label, sql })
            .collect(),
        default_batch: DEFAULT_BATCH,
        sort_budget_bytes: engine.config().sort_budget_bytes,
    }
}

async fn state(State(engine): State<Shared>) -> Json<StateResponse> {
    let engine = engine.clone();
    let state = tokio::task::spawn_blocking(move || state_of(&engine.lock()))
        .await
        .expect("state task");
    Json(state)
}

async fn run(State(engine): State<Shared>, Json(req): Json<RunRequest>) -> Response {
    let batch = req.batch.unwrap_or(DEFAULT_BATCH).clamp(1, 4096);
    let result: Result<Run, _> =
        tokio::task::spawn_blocking(move || engine.lock().run(&req.sql, batch)).await;
    match result {
        Ok(run) => Json(run).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("the engine panicked: {e}"),
        )
            .into_response(),
    }
}

async fn reset(State(engine): State<Shared>) -> Response {
    let result = tokio::task::spawn_blocking(move || {
        let mut engine = engine.lock();
        engine.reset().map(|()| state_of(&engine))
    })
    .await;
    match result {
        Ok(Ok(state)) => Json(state).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, e).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("reset panicked: {e}"),
        )
            .into_response(),
    }
}
