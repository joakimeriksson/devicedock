//! Port of scripts/login-relay.ts: opt-in OAuth callback relay for `codex login` inside the sandbox.
//! Binds host 127.0.0.1:1455 only while the login runs, forwards ONLY `GET /auth/callback`, and never logs request
//! contents (the query string holds the authorization code).
use crate::sandbox::{verify_managed, CONTAINER};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::process::Command;

const PORT: u16 = 1455;
const TIMEOUT: Duration = Duration::from_secs(10 * 60);

fn pipe_js() -> String {
    format!(
        "const s=require('net').connect({PORT},'localhost');process.stdin.pipe(s);s.pipe(process.stdout);\
         s.on('error',()=>process.exit(1));s.on('close',()=>process.exit(0))"
    )
}

pub async fn login_codex() -> Result<(), String> {
    verify_managed().await?;
    // A Codex TUI left open in the agent terminal holds its own login server on 1455 and hijacks the callback.
    let _ = Command::new("docker")
        .args([
            "exec", CONTAINER, "sh", "-c",
            r#"for p in /proc/[0-9]*; do case "$(tr "\0" " " < $p/cmdline 2>/dev/null)" in */bin/codex*) kill ${p#/proc/} 2>/dev/null && echo "Ended stray codex in sandbox (pid ${p#/proc/})";; esac; done"#,
        ])
        .status()
        .await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    let listener = TcpListener::bind(("127.0.0.1", PORT)).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::AddrInUse {
            format!("Port {PORT} is in use (probably a host Codex login or another process). Finish or cancel that first; this relay will not touch it.")
        } else {
            format!("Relay failed: {e}")
        }
    })?;
    eprintln!("Callback relay active on 127.0.0.1:{PORT} (stops when login ends, max 10 min).");
    let mut login = Command::new("docker")
        .args(["exec", "-it", CONTAINER, "codex", "login"])
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let accept = async {
        loop {
            if let Ok((c, _)) = listener.accept().await {
                tokio::spawn(relay_one(c));
            }
        }
    };
    let code = tokio::select! {
        s = login.wait() => {
            let s = s.map_err(|e| e.to_string())?;
            eprintln!("[relay] codex login exited code={:?}", s.code());
            s.code().unwrap_or(1)
        }
        _ = accept => 1,
        _ = tokio::time::sleep(TIMEOUT) => 1,
        _ = tokio::signal::ctrl_c() => 130,
    };
    eprintln!("Callback relay stopped.");
    if code == 0 {
        Ok(())
    } else {
        std::process::exit(code)
    }
}

async fn relay_one(mut client: TcpStream) {
    let mut first = vec![0u8; 4096];
    let n = match tokio::time::timeout(Duration::from_secs(15), client.read(&mut first)).await {
        Ok(Ok(n)) if n > 0 => n,
        _ => return,
    };
    first.truncate(n);
    let head = String::from_utf8_lossy(&first[..n.min(2048)]).into_owned();
    let line = head.split("\r\n").next().unwrap_or("");
    // Log method and path only; the query string holds the authorization code.
    let shown: Vec<&str> = line.split('?').next().unwrap_or("").split(' ').take(2).collect();
    let state = head.split(['?', '&']).find_map(|p| p.strip_prefix("state=")).map(|s| s.chars().take(6).collect::<String>());
    eprintln!("[relay] {} state={}...", shown.join(" "), state.unwrap_or_else(|| "-".into()));
    let ok = line.starts_with("GET /auth/callback") && matches!(line.as_bytes().get(18), Some(b'?') | Some(b' '));
    if !ok {
        let _ = client.write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").await;
        return;
    }
    let Ok(mut relay) = Command::new("docker")
        .args(["exec", "-i", CONTAINER, "node", "-e", &pipe_js()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    else {
        return;
    };
    let mut stdin = relay.stdin.take().unwrap();
    let mut stdout = relay.stdout.take().unwrap();
    if stdin.write_all(&first).await.is_err() {
        return;
    }
    let (mut cr, mut cw) = client.split();
    let up = async {
        let _ = tokio::io::copy(&mut cr, &mut stdin).await;
    };
    let down = async {
        let _ = tokio::io::copy(&mut stdout, &mut cw).await;
    };
    tokio::select! {
        _ = down => {}
        _ = async { up.await; std::future::pending::<()>().await } => {}
    }
    let _ = relay.kill().await;
}
