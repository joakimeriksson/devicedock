//! Inside the sandbox: the OpenOCD endpoints for shared debug probes. They speak the framing of OpenOCD's
//! `cmsis-dap backend tcp` (src/jtag/drivers/cmsis_dap_tcp.c) and turn every CMSIS-DAP packet into one
//! `probe.transfer` bridge operation. The broker enforces leases and the session approval (ARCHITECTURE.md §4.1);
//! this file holds no policy.
//!   OpenOCD: adapter driver cmsis-dap; cmsis-dap backend tcp; cmsis-dap tcp host 127.0.0.1; cmsis-dap tcp port 4441
use crate::device::DeviceClient;
use crate::protocol::{order_probes, R, MAX_DAP_PACKET};
use crate::rfc2217::Log;
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use serde_json::json;
use std::collections::VecDeque;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;

// Header: u32 signature "DAP\0", u16 payload length, u8 type, u8 reserved; little endian.
pub const DAP_SIGNATURE: u32 = 0x0050_4144;
pub const DAP_REQUEST: u8 = 1;
pub const DAP_RESPONSE: u8 = 2;
pub const DAP_HEADER: usize = 8;
/// Each transfer is short; a small deadline keeps the broker's replay window small at hundreds of packets/s.
const TRANSFER_TIMEOUT_MS: i64 = 5000;

pub fn encode_frame(payload: &[u8], kind: u8) -> Vec<u8> {
    let mut f = Vec::with_capacity(DAP_HEADER + payload.len());
    f.extend(DAP_SIGNATURE.to_le_bytes());
    f.extend((payload.len() as u16).to_le_bytes());
    f.extend([kind, 0]);
    f.extend(payload);
    f
}

/// Incremental decoder for request frames; TCP may split or merge them arbitrarily. Errors on a malformed header.
#[derive(Default)]
pub struct DapFramer {
    buf: Vec<u8>,
}

impl DapFramer {
    pub fn push(&mut self, chunk: &[u8]) -> R<Vec<Vec<u8>>> {
        self.buf.extend_from_slice(chunk);
        let mut out = vec![];
        let mut at = 0;
        while self.buf.len() - at >= DAP_HEADER {
            let h = &self.buf[at..];
            if u32::from_le_bytes([h[0], h[1], h[2], h[3]]) != DAP_SIGNATURE {
                return Err("bad DAP frame signature".into());
            }
            if h[6] != DAP_REQUEST {
                return Err(format!("unexpected DAP frame type {}", h[6]));
            }
            let n = u16::from_le_bytes([h[4], h[5]]) as usize;
            if n == 0 || n > MAX_DAP_PACKET {
                return Err(format!("DAP packet length {n} out of range"));
            }
            if h.len() < DAP_HEADER + n {
                break;
            }
            out.push(h[DAP_HEADER..DAP_HEADER + n].to_vec());
            at += DAP_HEADER + n;
        }
        self.buf.drain(..at);
        Ok(out)
    }
}

/// Starts one endpoint per slot on `port`+slot; returns the addresses that could be bound.
pub async fn start(api: DeviceClient, port: u16, host: &str, log: Log, slots: u16) -> Vec<SocketAddr> {
    let mut addrs = vec![];
    for slot in 0..slots {
        let listener = match TcpListener::bind((host, port + slot)).await {
            Ok(l) => l,
            Err(e) => {
                log(&format!("probe: port {}: {e}", port + slot));
                continue;
            }
        };
        addrs.extend(listener.local_addr());
        let (api, log) = (api.clone(), log.clone());
        tokio::spawn(async move {
            loop {
                if let Ok((socket, _)) = listener.accept().await {
                    tokio::spawn(session(api.clone(), log.clone(), socket, port + slot, slot));
                }
            }
        });
    }
    log(&format!(
        "OpenOCD (cmsis-dap tcp) probe endpoints on {host}:{port}-{} (probe N is on port {port}+N, see `device list`)",
        port + slots.max(1) - 1
    ));
    addrs
}

struct Inbox {
    queue: Mutex<VecDeque<Vec<u8>>>,
    open: AtomicBool,
    wake: Notify,
}

async fn session(api: DeviceClient, log: Log, socket: TcpStream, port: u16, slot: u16) {
    let _ = socket.set_nodelay(true);
    let (mut rd, mut wr) = socket.into_split();
    let inbox = Arc::new(Inbox { queue: Mutex::default(), open: AtomicBool::new(true), wake: Notify::new() });
    let (ib, lg) = (inbox.clone(), log.clone());
    let reader = tokio::spawn(async move {
        let mut framer = DapFramer::default();
        let mut buf = vec![0u8; 16384];
        loop {
            match rd.read(&mut buf).await {
                Ok(n) if n > 0 => match framer.push(&buf[..n]) {
                    Ok(pkts) => {
                        ib.queue.lock().unwrap().extend(pkts);
                        ib.wake.notify_one();
                    }
                    Err(e) => {
                        lg(&format!("probe: {e}; closing"));
                        break;
                    }
                },
                _ => break,
            }
        }
        ib.open.store(false, Ordering::SeqCst);
        ib.wake.notify_one();
    });
    let mut device = None;
    let mut lease: Option<String> = None;
    let serial = Arc::new(tokio::sync::Mutex::new(()));
    let mut keepalive = None;
    let r: R<()> = async {
        let devices = api.list().await?;
        let d = order_probes(&devices).into_iter().nth(slot as usize).ok_or_else(|| {
            format!("port {port} has no debug probe (share one with \"Add debug probe\", then check `device list`)")
        })?;
        device = Some(d.clone());
        for i in 0.. {
            match api.acquire(&d).await {
                Ok(l) => {
                    lease = Some(l);
                    break;
                }
                Err(e) => {
                    if !e.to_lowercase().contains("already leased") || i >= 60 || !inbox.open.load(Ordering::SeqCst) {
                        return Err(e);
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
            }
        }
        let l = lease.clone().unwrap_or_default();
        // Opening is instant when a session is already approved (or autonomous mode is on). Otherwise the human must
        // approve in the page; OpenOCD gives up on its first packet after 6 s, so agents run `device probe-open` first.
        {
            let _g = serial.lock().await;
            api.op("probe.open", &d, json!({}), Some(&l)).await?;
        }
        // Hold the lease while OpenOCD idles between commands (a GDB session can sit for minutes).
        let (a, d2, l2, s2) = (api.clone(), d.clone(), l.clone(), serial.clone());
        keepalive = Some(tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                let _g = s2.lock().await;
                let _ = a.op("serial.read", &d2, json!({"maxBytes": 1}), Some(&l2)).await;
            }
        }));
        while inbox.open.load(Ordering::SeqCst) {
            let Some(pkt) = inbox.queue.lock().unwrap().pop_front() else {
                inbox.wake.notified().await;
                continue;
            };
            let r = {
                let _g = serial.lock().await;
                api.call("probe.transfer", Some(&d), json!({"data": STANDARD.encode(&pkt)}), Some(&l), TRANSFER_TIMEOUT_MS).await?
            };
            if inbox.open.load(Ordering::SeqCst) {
                let data = STANDARD.decode(r["data"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
                wr.write_all(&encode_frame(&data, DAP_RESPONSE)).await.map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = r {
        log(&format!("probe: session on port {port} ended: {e}"));
    }
    if let Some(k) = keepalive {
        k.abort();
    }
    reader.abort();
    drop(wr);
    if let (Some(d), Some(l)) = (device, lease) {
        let _ = api.release(&d, &l).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rfc2217::tests::fake;

    #[test]
    fn frames_match_openocds_cmsis_dap_tcp() {
        let f = encode_frame(&[0x00, 0xfe], DAP_REQUEST);
        assert_eq!(f[..8], [0x44, 0x41, 0x50, 0x00, 2, 0, DAP_REQUEST, 0]);
        assert_eq!(encode_frame(&[1], DAP_RESPONSE)[6], DAP_RESPONSE);
    }

    #[test]
    fn framer_reassembles_split_and_merged_frames() {
        let all = [encode_frame(&[1, 2, 3], DAP_REQUEST), encode_frame(&[9], DAP_REQUEST)].concat();
        let mut fr = DapFramer::default();
        let got: Vec<Vec<u8>> = all.iter().flat_map(|b| fr.push(&[*b]).unwrap()).collect(); // byte by byte
        assert_eq!(got, [vec![1, 2, 3], vec![9]]);
        assert_eq!(DapFramer::default().push(&all).unwrap(), [vec![1, 2, 3], vec![9]]); // both in one chunk
    }

    #[test]
    fn framer_rejects_a_bad_signature_a_response_frame_and_an_oversized_length() {
        assert!(DapFramer::default().push(b"GET / HTTP/1.1\r\n").unwrap_err().contains("signature"));
        assert!(DapFramer::default().push(&encode_frame(&[1], DAP_RESPONSE)).unwrap_err().contains("type"));
        let mut big = DAP_SIGNATURE.to_le_bytes().to_vec();
        big.extend(2000u16.to_le_bytes());
        big.extend([DAP_REQUEST, 0]);
        assert!(DapFramer::default().push(&big).unwrap_err().contains("out of range"));
    }

    #[tokio::test]
    async fn endpoint_acquires_opens_the_session_relays_packets_in_order_and_releases_on_close() {
        let calls: Arc<Mutex<Vec<String>>> = Arc::default();
        let probe = json!({"id": uuid::Uuid::new_v4().to_string(), "generation": 1, "name": "XDS110", "kind": "probe", "baudRate": 115200});
        let serial = json!({"id": uuid::Uuid::new_v4().to_string(), "generation": 1, "name": "XDS110", "kind": "serial", "baudRate": 115200});
        let c = calls.clone();
        let api = fake(move |op, args| {
            c.lock().unwrap().push(op.to_string());
            match op {
                "devices.list" => Ok(json!([serial, probe])),
                "serial.acquire" => Ok(json!({"lease": uuid::Uuid::new_v4().to_string()})),
                "probe.transfer" => {
                    let pkt = STANDARD.decode(args["data"].as_str().unwrap()).unwrap();
                    if pkt[0] == 1 {
                        std::thread::sleep(Duration::from_millis(20)); // the first is slower: order must hold
                    }
                    Ok(json!({"data": STANDARD.encode([pkt[0], 0xaa])}))
                }
                _ => Ok(json!({})),
            }
        });
        let addrs = start(api, 0, "127.0.0.1", Arc::new(|_| {}), 1).await;
        let mut sock = TcpStream::connect(addrs[0]).await.unwrap();
        let frames: Vec<u8> = [1u8, 2, 3].iter().flat_map(|i| encode_frame(&[*i], DAP_REQUEST)).collect();
        sock.write_all(&frames).await.unwrap();
        let mut buf = vec![0u8; 30];
        tokio::time::timeout(Duration::from_secs(5), sock.read_exact(&mut buf)).await.unwrap().unwrap();
        let replies: Vec<&[u8]> = buf.chunks(10).collect();
        for (i, r) in replies.iter().enumerate() {
            assert_eq!(r[6], DAP_RESPONSE);
            assert_eq!(&r[4..6], &[2, 0]);
            assert_eq!(&r[8..], &[i as u8 + 1, 0xaa]);
        }
        drop(sock);
        for _ in 0..100 {
            if calls.lock().unwrap().iter().any(|c| c == "serial.release") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let calls = calls.lock().unwrap();
        assert_eq!(calls[..3], ["devices.list", "serial.acquire", "probe.open"]);
        assert_eq!(calls.last().map(String::as_str), Some("serial.release"));
    }
}
