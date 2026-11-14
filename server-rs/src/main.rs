//! DeviceDock host backend in one binary. Subcommands:
//!   serve (default)            the loopback web server + broker (apps/server/index.ts)
//!   open                       mint a fresh one-time login link and open it in Chrome (scripts/open.mjs)
//!   sandbox start|stop|clean   manage the hardened sandbox container (scripts/sandbox.ts)
//!   login-codex                run `codex login` in the sandbox with the OAuth callback relay (scripts/login-relay.ts)
//!   tunnel                     inside the sandbox only: its network path to the backend (see tunnel.rs)
//! Files live in ./.runtime and ./dist relative to the working directory, exactly like the Node backend.
mod app;
mod broker;
mod firewall;
mod protocol;
mod relay;
mod sandbox;
mod terminals;
mod tunnel;

use std::process::ExitCode;

fn port() -> u16 {
    std::env::var("PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(47831)
}

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        [] | ["serve"] => serve().await,
        ["open"] => open().await,
        ["sandbox", "start"] => sandbox::start_sandbox().await.map(|_| println!("Sandbox started.")),
        ["sandbox", "stop"] => {
            sandbox::stop_sandbox().await.map(|_| println!("Sandbox stopped; workspace and credentials preserved."))
        }
        ["sandbox", "clean"] => sandbox::clean_sandbox()
            .await
            .map(|_| println!("Container removed. Volumes preserved. See README for explicit data removal.")),
        ["login-codex"] => relay::login_codex().await,
        ["tunnel"] => tunnel::run_in_sandbox().await,
        ["--version"] | ["version"] => {
            println!("devicedock {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err("usage: devicedock [serve | open | sandbox start|stop|clean | login-codex | --version]".into()),
    };
    match r {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{e}");
            ExitCode::FAILURE
        }
    }
}

async fn serve() -> Result<(), String> {
    let port = port();
    // The admin token authorises `devicedock open` to mint a fresh login link without a restart. It lives only on
    // the host (mode 0600) and is never given to the container, unlike the bridge token.
    sandbox::ensure_runtime_dir().map_err(|e| e.to_string())?;
    let admin_token = match std::fs::read_to_string(".runtime/admin-token").map(|s| s.trim().to_string()) {
        Ok(t) if t.len() >= 32 => t,
        _ => {
            let t = sandbox::random_hex();
            sandbox::write_secret(".runtime/admin-token", &t).map_err(|e| e.to_string())?;
            t
        }
    };
    let bootstrap = std::env::var("DEVICEDOCK_TEST_BOOTSTRAP").ok().filter(|t| t.len() >= 32).unwrap_or_else(sandbox::random_hex);
    let test = std::env::var("DEVICEDOCK_TEST").is_ok_and(|v| v == "1");
    let app = app::App::new(app::Options { port, bootstrap: bootstrap.clone(), admin_token: Some(admin_token) });
    // Do not replace the active server's bootstrap link unless we own the port.
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            return Err(format!(
                "Port {port} is already in use. If DeviceDock is already running, use ./devicedock.sh open. Otherwise stop the process using that port and start again."
            ))
        }
        Err(e) => return Err(format!("DeviceDock could not start: {e}")),
    };
    sandbox::write_secret(".runtime/session-link", &format!("{}/#token={bootstrap}", app.origin)).map_err(|e| e.to_string())?;
    println!("DeviceDock listening on {}. Run ./devicedock.sh open to authenticate in your browser.", app.origin);
    if !test {
        app::spawn_bridge(app.clone());
        tokio::spawn(app.firewall.clone().run_tunnel());
    }
    let router = axum::Router::new().fallback(app::handle).with_state(app.clone());
    let shutdown = {
        let app = app.clone();
        async move {
            let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = term.recv() => {}
            }
            app.close();
        }
    };
    axum::serve(listener, router).with_graceful_shutdown(shutdown).await.map_err(|e| e.to_string())
}

/// Prefer a fresh one-time link minted by the running backend (works after the first link was used or the session
/// expired, without a restart); fall back to the link written when the backend started.
async fn open() -> Result<(), String> {
    let link = match fresh_link().await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Could not get a fresh link from the backend ({e}); using the startup link.");
            std::fs::read_to_string(".runtime/session-link").map_err(|e| e.to_string())?.trim().to_string()
        }
    };
    // WebSerial needs Chrome/Edge, and the one-time link is spent by whichever browser opens it first.
    // Override with BROWSER_APP="Microsoft Edge" (macOS app name).
    let app = std::env::var("BROWSER_APP").unwrap_or_else(|_| "Google Chrome".into());
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        c.args(["-a", &app, &link]);
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&link);
        c
    };
    cmd.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn().map_err(|e| e.to_string())?;
    println!("Opened a login link in {}.", if cfg!(target_os = "macos") { app.as_str() } else { "your browser" });
    Ok(())
}

/// POST /admin/session-link over a raw loopback connection (no HTTP client dependency needed for one request).
async fn fresh_link() -> Result<String, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let token = std::fs::read_to_string(".runtime/admin-token").map_err(|e| e.to_string())?;
    let port = port();
    let fut = async {
        let mut s = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.map_err(|e| e.to_string())?;
        let req = format!(
            "POST /admin/session-link HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            token.trim()
        );
        s.write_all(req.as_bytes()).await.map_err(|e| e.to_string())?;
        let mut buf = vec![];
        s.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        Ok::<_, String>(String::from_utf8_lossy(&buf).into_owned())
    };
    let resp = tokio::time::timeout(std::time::Duration::from_secs(4), fut).await.map_err(|_| "timeout".to_string())??;
    let status = resp.split(' ').nth(1).unwrap_or("");
    if status != "200" {
        return Err(format!("backend refused to mint a link (HTTP {status})"));
    }
    let body = resp.split("\r\n\r\n").nth(1).unwrap_or("");
    let v: serde_json::Value = serde_json::from_str(body).map_err(|e| e.to_string())?;
    v["url"].as_str().map(String::from).ok_or_else(|| "no url in reply".into())
}
