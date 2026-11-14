//! Port of apps/server/sandbox.ts: the hardened sandbox container and the health probe.
use rand::RngCore;
use serde_json::{json, Value};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

pub const CONTAINER: &str = "devicedock-sandbox";
pub const BRIDGE_PORT: u16 = 47832;
pub const IMAGE: &str = "devicedock-sandbox:local";

pub fn random_hex() -> String {
    let mut b = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut b);
    hex::encode(b)
}

pub async fn docker_timeout(args: &[&str], secs: u64) -> Result<String, String> {
    let out = Command::new("docker").args(args).stdin(Stdio::null()).kill_on_drop(true).output();
    let out = tokio::time::timeout(Duration::from_secs(secs), out)
        .await
        .map_err(|_| format!("docker {} timed out", args.first().unwrap_or(&"")))?
        .map_err(|e| format!("docker: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("Command failed: docker {}\n{}", args.join(" "), err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}
pub async fn docker(args: &[&str]) -> Result<String, String> {
    docker_timeout(args, 120).await
}

pub async fn health() -> Value {
    let (mut docker_ok, mut container, mut agent) = (false, false, false);
    let mut error = None;
    let r: Result<(), String> = async {
        docker_timeout(&["info", "--format", "{{.ServerVersion}}"], 5).await?;
        docker_ok = true;
        container = docker(&["inspect", "--format", "{{.State.Running}}", CONTAINER]).await? == "true";
        if container {
            docker(&["exec", CONTAINER, "codex", "--version"]).await?;
            agent = true;
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        error = Some(e.chars().take(350).collect::<String>());
    }
    let mut v = json!({"docker": docker_ok, "container": container, "agent": agent});
    if let Some(e) = error {
        v["error"] = json!(e);
    }
    v
}

pub fn bridge_token() -> std::io::Result<String> {
    Ok(std::fs::read_to_string(".runtime/bridge-token")?.trim().to_string())
}

pub async fn verify_managed() -> Result<(), String> {
    let label = docker(&["inspect", "--format", "{{index .Config.Labels \"devicedock.managed\"}}", CONTAINER]).await?;
    if label != "true" {
        return Err("A container with this name already exists and is not managed by DeviceDock".into());
    }
    Ok(())
}

async fn sandbox_exists() -> Result<bool, String> {
    let filter = format!("name=^/{CONTAINER}$");
    let names = docker(&["container", "ls", "--all", "--filter", &filter, "--format", "{{.Names}}"]).await?;
    Ok(names.lines().any(|n| n.trim() == CONTAINER))
}

pub fn ensure_runtime_dir() -> std::io::Result<()> {
    std::fs::create_dir_all(".runtime")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(".runtime", std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// Writes a secret file readable only by the user (mode 0600).
pub fn write_secret(path: &str, content: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)?.write_all(content.as_bytes())
}

pub async fn start_sandbox() -> Result<(), String> {
    ensure_runtime_dir().map_err(|e| e.to_string())?;
    let token = match bridge_token() {
        Ok(t) if !t.is_empty() => t,
        _ => {
            let t = random_hex();
            write_secret(".runtime/bridge-token", &t).map_err(|e| e.to_string())?;
            t
        }
    };
    if sandbox_exists().await? {
        verify_managed().await?;
        docker(&["start", CONTAINER]).await?;
    } else {
        docker(&["volume", "create", "devicedock-workspace"]).await?;
        docker(&["volume", "create", "devicedock-home"]).await?;
        // Images with `devicedock tunnel` (label devicedock.tunnel=1) get no network at all: the backend reaches the
        // bridge and the sandbox reaches the internet only through the tunnel, past the firewall (firewall.rs).
        // Older images keep the previous setup: open network, bridge port published on the host's loopback.
        let tunnel = docker(&["image", "inspect", "--format", "{{index .Config.Labels \"devicedock.tunnel\"}}", IMAGE]).await? == "1";
        let publish = format!("127.0.0.1:{BRIDGE_PORT}:47832");
        let mut args: Vec<&str> = vec![
            "run", "-d", "--name", CONTAINER, "--label", "devicedock.managed=true",
            "--user", "1000:1000", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--cpus=2", "--memory=2g",
            "--pids-limit=256", "--read-only", "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
            "--mount", "type=volume,src=devicedock-workspace,dst=/workspace",
            "--mount", "type=volume,src=devicedock-home,dst=/home/node",
        ];
        if tunnel {
            args.extend(["--network", "none", "--label", "devicedock.network=tunnel"]);
            for e in crate::firewall::PROXY_ENV {
                args.extend(["--env", e]);
            }
        } else {
            eprintln!("This sandbox image has no network firewall (no `devicedock tunnel`): the sandbox gets open internet.");
            args.extend(["-p", &publish]);
        }
        args.push(IMAGE);
        docker(&args).await?;
    }
    // Send the token over stdin, never in command arguments or Docker environment metadata.
    let mut p = Command::new("docker")
        .args(["exec", "-i", CONTAINER, "sh", "-c", "umask 077; cat > /home/node/.bridge-token"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = p.stdin.take().unwrap();
    stdin.write_all(token.as_bytes()).await.map_err(|e| e.to_string())?;
    drop(stdin);
    let status = p.wait().await.map_err(|e| e.to_string())?;
    if !status.success() {
        return Err("Could not provision bridge token".into());
    }
    Ok(())
}

pub async fn stop_sandbox() -> Result<(), String> {
    verify_managed().await?;
    docker(&["stop", CONTAINER]).await.map(|_| ())
}

pub async fn clean_sandbox() -> Result<(), String> {
    verify_managed().await?;
    docker(&["rm", "-f", CONTAINER]).await.map(|_| ())
}
