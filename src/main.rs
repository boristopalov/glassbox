use glassbox::engine::{Config, Engine};
use glassbox::server;
use parking_lot::Mutex;
use std::net::SocketAddr;
use std::process::ExitCode;
use std::sync::Arc;

const USAGE: &str = "\
usage: glassbox [--port N] [--frames N] [--sort-budget-kb N] [--empty] [DIR]

Starts Glass Box, an x-ray SQL shell for cmudb, at http://127.0.0.1:PORT.

  DIR                 open (or create) the cmudb database in DIR instead of a scratch one
  --port N            port to serve on (default 7878)
  --frames N          buffer pool frames (default 64)
  --sort-budget-kb N  ORDER BY memory before it spills sorted runs (default 64)
  --empty             start without the demo users and orders tables";

struct Args {
    port: u16,
    config: Config,
}

fn parse_args() -> Result<Args, String> {
    let mut port = 7878;
    let mut config = Config {
        frames: 64,
        dir: None,
        sort_budget_bytes: 64 * 1024,
        demo: true,
    };
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let mut value = |name: &str| {
            args.next()
                .ok_or_else(|| format!("{name} needs a value"))?
                .parse::<usize>()
                .map_err(|e| format!("{name}: {e}"))
        };
        match arg.as_str() {
            "-h" | "--help" => return Err(String::new()),
            "--port" => port = u16::try_from(value("--port")?).map_err(|e| e.to_string())?,
            "--frames" => config.frames = value("--frames")?.max(4),
            "--sort-budget-kb" => {
                config.sort_budget_bytes = value("--sort-budget-kb")?.max(1) * 1024
            }
            "--empty" => config.demo = false,
            flag if flag.starts_with('-') => return Err(format!("unknown flag {flag}")),
            dir => config.dir = Some(dir.into()),
        }
    }
    Ok(Args { port, config })
}

#[tokio::main]
async fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) if e.is_empty() => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(e) => {
            eprintln!("error: {e}\n\n{USAGE}");
            return ExitCode::FAILURE;
        }
    };
    let frames = args.config.frames;
    println!("glass box ▸ warming up cmudb ({frames} frames)…");
    let engine = match tokio::task::spawn_blocking(move || Engine::open(args.config)).await {
        Ok(Ok(e)) => e,
        Ok(Err(e)) => {
            eprintln!("error: {e}");
            return ExitCode::FAILURE;
        }
        Err(e) => {
            eprintln!("error: the engine panicked while starting: {e}");
            return ExitCode::FAILURE;
        }
    };
    let app = server::router(Arc::new(Mutex::new(engine)));
    let addr = SocketAddr::from(([127, 0, 0, 1], args.port));
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: cannot listen on {addr}: {e}");
            return ExitCode::FAILURE;
        }
    };
    println!("glass box ▸ open http://{addr}");
    let shutdown = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
    {
        eprintln!("error: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}
