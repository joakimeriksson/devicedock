//! The sandbox's only network path: many TCP connections multiplexed over one byte pipe, the stdin/stdout of
//! `docker exec -i devicedock-sandbox devicedock tunnel`. The sandbox runs with `--network none`; inside it,
//! `devicedock tunnel` listens on 127.0.0.1:3128 (the HTTP(S) proxy every tool is pointed at) and sends each
//! connection through the pipe to the backend, which decides (firewall.rs) and connects out from the host. The
//! other direction carries the backend's link to the sandbox's bridge service (127.0.0.1:47832).
//!
//! Frames: kind u8, stream id u32 BE, payload length u32 BE, payload. The backend opens even ids, the sandbox odd.
//! Flow control is per stream and credit based (like HTTP/2): a sender may have at most WINDOW bytes in flight
//! per stream, and the receiver returns credit as the local socket accepts the bytes. So the reader of the pipe
//! never waits for a slow socket and one stalled download cannot hold up the device link.
//!
//! Everything arriving from the sandbox is untrusted: any process in the sandbox can write to the pipe. The backend
//! side only accepts proxy streams (which firewall.rs checks) and drops the pipe on any protocol violation.
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufWriter, DuplexStream};
use tokio::sync::{mpsc, watch, Notify};

pub const WINDOW: u32 = 256 * 1024;
pub const MAX_PAYLOAD: u32 = 64 * 1024;
pub const MAX_STREAMS: usize = 256;
const CHUNK: usize = 16 * 1024;
const MAX_TARGET: u32 = 256;

/// The proxy port inside the sandbox; HTTPS_PROXY points here.
pub const PROXY_PORT: u16 = 3128;
/// Sandbox ports the backend may open a stream to.
pub const SANDBOX_PORTS: [u16; 1] = [crate::sandbox::BRIDGE_PORT];
/// Where the image installs the binary (sandbox/Dockerfile).
pub const SANDBOX_BIN: &str = "/opt/devicedock/bin/devicedock";

const OPEN: u8 = 1;
const DATA: u8 = 2;
const CREDIT: u8 = 3;
const FIN: u8 = 4;
const RESET: u8 = 5;

struct Frame {
    kind: u8,
    id: u32,
    payload: Vec<u8>,
}

enum Inbound {
    Data(Vec<u8>),
    Fin,
}

struct StreamShared {
    /// Bytes this side may still send.
    credit: Mutex<i64>,
    credit_notify: Notify,
    /// Bytes received from the peer and not yet written to the local socket; never more than WINDOW.
    unacked: AtomicI64,
    inbox: mpsc::UnboundedSender<Inbound>,
    reset: watch::Sender<bool>,
    /// Number of finished pumps (outbound, inbound); at 2 the stream is forgotten.
    done: AtomicU8,
}

struct Inner {
    out: mpsc::Sender<Frame>,
    streams: Mutex<HashMap<u32, Arc<StreamShared>>>,
    next_id: AtomicU32,
    closed: watch::Sender<bool>,
    is_closed: AtomicBool,
}

impl Inner {
    fn shut(&self) {
        if self.is_closed.swap(true, Ordering::SeqCst) {
            return;
        }
        let _ = self.closed.send_replace(true);
        for (_, s) in self.streams.lock().unwrap().drain() {
            let _ = s.reset.send_replace(true);
        }
    }
    fn forget(&self, id: u32, s: &StreamShared) {
        if s.done.fetch_add(1, Ordering::SeqCst) + 1 >= 2 {
            self.streams.lock().unwrap().remove(&id);
        }
    }
    fn reset_local(&self, id: u32) {
        if let Some(s) = self.streams.lock().unwrap().remove(&id) {
            let _ = s.reset.send_replace(true);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Side {
    Backend,
    Sandbox,
}

/// A stream the peer opened: what it asked for, and the connection.
pub struct Incoming {
    pub target: Vec<u8>,
    pub stream: DuplexStream,
}

#[derive(Clone)]
pub struct Mux(Arc<Inner>);

impl Mux {
    /// Runs the multiplexer over a reader/writer pair until either side ends or the peer breaks the protocol.
    pub fn start<R, W>(reader: R, writer: W, side: Side) -> (Mux, mpsc::Receiver<Incoming>)
    where
        R: AsyncRead + Unpin + Send + 'static,
        W: AsyncWrite + Unpin + Send + 'static,
    {
        let (out, out_rx) = mpsc::channel(256);
        let inner = Arc::new(Inner {
            out,
            streams: Mutex::default(),
            next_id: AtomicU32::new(if side == Side::Backend { 2 } else { 1 }),
            closed: watch::channel(false).0,
            is_closed: AtomicBool::new(false),
        });
        let (in_tx, in_rx) = mpsc::channel(64);
        tokio::spawn(write_loop(writer, out_rx, inner.clone()));
        tokio::spawn(read_loop(reader, inner.clone(), in_tx, side));
        (Mux(inner), in_rx)
    }

    pub async fn open(&self, target: &[u8]) -> Result<DuplexStream, String> {
        if self.is_closed() {
            return Err("tunnel closed".into());
        }
        if target.len() > MAX_TARGET as usize {
            return Err("target too long".into());
        }
        let id = self.0.next_id.fetch_add(2, Ordering::SeqCst);
        let (shared, inbox) = {
            let mut streams = self.0.streams.lock().unwrap();
            if streams.len() >= MAX_STREAMS {
                return Err("too many connections through the tunnel".into());
            }
            let (s, rx) = new_stream();
            streams.insert(id, s.clone());
            (s, rx)
        };
        self.0
            .out
            .send(Frame { kind: OPEN, id, payload: target.to_vec() })
            .await
            .map_err(|_| "tunnel closed".to_string())?;
        Ok(attach(self.0.clone(), id, shared, inbox))
    }

    pub fn is_closed(&self) -> bool {
        self.0.is_closed.load(Ordering::SeqCst)
    }

    pub async fn closed(&self) {
        let mut rx = self.0.closed.subscribe();
        let _ = rx.wait_for(|c| *c).await;
    }

    pub fn close(&self) {
        self.0.shut();
    }

    #[cfg(test)]
    pub fn streams(&self) -> usize {
        self.0.streams.lock().unwrap().len()
    }
}

fn new_stream() -> (Arc<StreamShared>, mpsc::UnboundedReceiver<Inbound>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let s = Arc::new(StreamShared {
        credit: Mutex::new(WINDOW as i64),
        credit_notify: Notify::new(),
        unacked: AtomicI64::new(0),
        inbox: tx,
        reset: watch::channel(false).0,
        done: AtomicU8::new(0),
    });
    (s, rx)
}

/// Connects a stream to a local in-memory pipe: the caller gets one end, two pumps move bytes and credit.
fn attach(inner: Arc<Inner>, id: u32, s: Arc<StreamShared>, mut inbox: mpsc::UnboundedReceiver<Inbound>) -> DuplexStream {
    let (user, ours) = tokio::io::duplex(64 * 1024);
    let (mut rd, mut wr) = tokio::io::split(ours);

    // Local -> peer: read what the caller writes, wait for credit, send DATA; FIN at end of input.
    let (inner2, s2) = (inner.clone(), s.clone());
    tokio::spawn(async move {
        let mut reset = s2.reset.subscribe();
        let mut buf = vec![0u8; CHUNK];
        'outer: loop {
            let n = tokio::select! {
                r = rd.read(&mut buf) => r.unwrap_or(0),
                _ = reset.wait_for(|r| *r) => break 'outer,
            };
            if n == 0 {
                let _ = inner2.out.send(Frame { kind: FIN, id, payload: vec![] }).await;
                break;
            }
            let mut sent = 0;
            while sent < n {
                let take = loop {
                    let notified = s2.credit_notify.notified();
                    {
                        let mut c = s2.credit.lock().unwrap();
                        if *c > 0 {
                            let take = (*c as usize).min(n - sent);
                            *c -= take as i64;
                            break take;
                        }
                    }
                    tokio::select! {
                        _ = notified => {}
                        _ = reset.wait_for(|r| *r) => break 'outer,
                    }
                };
                let payload = buf[sent..sent + take].to_vec();
                if inner2.out.send(Frame { kind: DATA, id, payload }).await.is_err() {
                    break 'outer;
                }
                sent += take;
            }
        }
        inner2.forget(id, &s2);
    });

    // Peer -> local: write DATA to the caller, then return the credit; FIN closes the caller's read side.
    tokio::spawn(async move {
        let mut reset = s.reset.subscribe();
        loop {
            let m = tokio::select! {
                m = inbox.recv() => m,
                _ = reset.wait_for(|r| *r) => None,
            };
            match m {
                Some(Inbound::Data(d)) => {
                    let n = d.len();
                    if wr.write_all(&d).await.is_err() {
                        // The caller is gone: tell the peer to stop sending.
                        let _ = inner.out.send(Frame { kind: RESET, id, payload: vec![] }).await;
                        inner.reset_local(id);
                        break;
                    }
                    s.unacked.fetch_sub(n as i64, Ordering::SeqCst);
                    let credit = (n as u32).to_be_bytes().to_vec();
                    if inner.out.send(Frame { kind: CREDIT, id, payload: credit }).await.is_err() {
                        break;
                    }
                }
                Some(Inbound::Fin) => {
                    let _ = wr.shutdown().await;
                    break;
                }
                None => break,
            }
        }
        inner.forget(id, &s);
    });
    user
}

async fn write_loop<W: AsyncWrite + Unpin>(writer: W, mut rx: mpsc::Receiver<Frame>, inner: Arc<Inner>) {
    let mut w = BufWriter::with_capacity(128 * 1024, writer);
    let mut closed = inner.closed.subscribe();
    let ok: std::io::Result<()> = async {
        loop {
            let f = tokio::select! {
                f = rx.recv() => f,
                _ = closed.wait_for(|c| *c) => None,
            };
            let Some(mut f) = f else { return Ok(()) };
            loop {
                let mut head = [0u8; 9];
                head[0] = f.kind;
                head[1..5].copy_from_slice(&f.id.to_be_bytes());
                head[5..9].copy_from_slice(&(f.payload.len() as u32).to_be_bytes());
                w.write_all(&head).await?;
                w.write_all(&f.payload).await?;
                match rx.try_recv() {
                    Ok(next) => f = next,
                    Err(_) => break,
                }
            }
            w.flush().await?;
        }
    }
    .await;
    let _ = ok;
    let _ = w.shutdown().await;
    inner.shut();
}

/// Reads frames. Never waits on a local socket or on the outgoing queue, so the pipe always drains.
async fn read_loop<R: AsyncRead + Unpin>(mut reader: R, inner: Arc<Inner>, incoming: mpsc::Sender<Incoming>, side: Side) {
    let peer_parity = if side == Side::Backend { 1 } else { 0 };
    let reset = |id: u32| {
        let _ = inner.out.try_send(Frame { kind: RESET, id, payload: vec![] });
    };
    loop {
        let mut head = [0u8; 9];
        if reader.read_exact(&mut head).await.is_err() {
            break;
        }
        let kind = head[0];
        let id = u32::from_be_bytes(head[1..5].try_into().unwrap());
        let len = u32::from_be_bytes(head[5..9].try_into().unwrap());
        if len > MAX_PAYLOAD {
            break; // protocol violation
        }
        let mut payload = vec![0u8; len as usize];
        if reader.read_exact(&mut payload).await.is_err() {
            break;
        }
        let stream = inner.streams.lock().unwrap().get(&id).cloned();
        match kind {
            OPEN => {
                if id % 2 != peer_parity || stream.is_some() || len > MAX_TARGET {
                    break;
                }
                let (s, inbox) = {
                    let mut streams = inner.streams.lock().unwrap();
                    if streams.len() >= MAX_STREAMS {
                        drop(streams);
                        reset(id);
                        continue;
                    }
                    let (s, rx) = new_stream();
                    streams.insert(id, s.clone());
                    (s, rx)
                };
                let conn = attach(inner.clone(), id, s, inbox);
                if incoming.try_send(Incoming { target: payload, stream: conn }).is_err() {
                    inner.reset_local(id);
                    reset(id);
                }
            }
            DATA => {
                let Some(s) = stream else { continue }; // a stream we already reset
                if s.unacked.fetch_add(len as i64, Ordering::SeqCst) + len as i64 > WINDOW as i64 {
                    break; // the peer ignored flow control
                }
                let _ = s.inbox.send(Inbound::Data(payload));
            }
            CREDIT => {
                let (Some(s), Ok(b)) = (stream, <[u8; 4]>::try_from(payload.as_slice())) else { continue };
                let mut c = s.credit.lock().unwrap();
                *c = (*c + u32::from_be_bytes(b) as i64).min(WINDOW as i64);
                s.credit_notify.notify_one();
            }
            FIN => {
                if let Some(s) = stream {
                    let _ = s.inbox.send(Inbound::Fin);
                }
            }
            RESET => inner.reset_local(id),
            _ => break,
        }
    }
    inner.shut();
}

/// `devicedock tunnel`, run inside the sandbox by the backend. Exits when the backend closes the pipe.
pub async fn run_in_sandbox() -> Result<(), String> {
    let listener = {
        let mut tries = 0;
        loop {
            // A previous tunnel may still be exiting after a backend restart.
            match tokio::net::TcpListener::bind(("127.0.0.1", PROXY_PORT)).await {
                Ok(l) => break l,
                Err(e) if tries < 20 => {
                    tries += 1;
                    let _ = e;
                    tokio::time::sleep(std::time::Duration::from_millis(250)).await;
                }
                Err(e) => return Err(format!("cannot listen on 127.0.0.1:{PROXY_PORT}: {e}")),
            }
        }
    };
    let (mux, mut incoming) = Mux::start(tokio::io::stdin(), tokio::io::stdout(), Side::Sandbox);
    let m = mux.clone();
    let accept = async move {
        loop {
            let Ok((mut tcp, _)) = listener.accept().await else { continue };
            let m = m.clone();
            tokio::spawn(async move {
                if let Ok(mut s) = m.open(b"proxy").await {
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut s).await;
                }
            });
        }
    };
    let serve = async move {
        while let Some(Incoming { target, mut stream }) = incoming.recv().await {
            let port = std::str::from_utf8(&target).ok().and_then(|t| t.strip_prefix("tcp:")).and_then(|p| p.parse::<u16>().ok());
            let Some(port) = port.filter(|p| SANDBOX_PORTS.contains(p)) else { continue };
            tokio::spawn(async move {
                if let Ok(mut tcp) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut stream).await;
                }
            });
        }
    };
    tokio::select! {
        _ = accept => {}
        _ = serve => {}
        _ = mux.closed() => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::time::timeout;

    fn pair() -> ((Mux, mpsc::Receiver<Incoming>), (Mux, mpsc::Receiver<Incoming>)) {
        let (a, b) = tokio::io::duplex(64 * 1024);
        let (ar, aw) = tokio::io::split(a);
        let (br, bw) = tokio::io::split(b);
        (Mux::start(ar, aw, Side::Backend), Mux::start(br, bw, Side::Sandbox))
    }

    async fn echo_server(mut rx: mpsc::Receiver<Incoming>) {
        while let Some(Incoming { mut stream, .. }) = rx.recv().await {
            tokio::spawn(async move {
                let (mut r, mut w) = tokio::io::split(&mut stream);
                let _ = tokio::io::copy(&mut r, &mut w).await;
                let _ = w.shutdown().await;
            });
        }
    }

    #[tokio::test]
    async fn streams_both_ways_with_target() {
        let ((backend, _), (sandbox, mut incoming)) = pair();
        let mut s = backend.open(b"tcp:47832").await.unwrap();
        s.write_all(b"hello").await.unwrap();
        let mut inc = timeout(Duration::from_secs(2), incoming.recv()).await.unwrap().unwrap();
        assert_eq!(inc.target, b"tcp:47832");
        let mut buf = [0u8; 5];
        inc.stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"hello");
        inc.stream.write_all(b"world").await.unwrap();
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"world");
        // The sandbox side opens odd ids, the backend even ones.
        let _t = sandbox.open(b"proxy").await.unwrap();
    }

    #[tokio::test]
    async fn half_close_then_reply() {
        let ((backend, _), (_sandbox, incoming)) = pair();
        tokio::spawn(echo_server(incoming));
        let mut s = backend.open(b"x").await.unwrap();
        s.write_all(b"request").await.unwrap();
        s.shutdown().await.unwrap(); // FIN: no more from us, but we still read
        let mut got = Vec::new();
        timeout(Duration::from_secs(2), s.read_to_end(&mut got)).await.unwrap().unwrap();
        assert_eq!(got, b"request");
    }

    #[tokio::test]
    async fn big_transfer_is_exact_and_a_stalled_stream_does_not_block_others() {
        let ((backend, _), (_sandbox, mut incoming)) = pair();
        // Stream 1: 8 MB that nobody reads for a while.
        let mut big = backend.open(b"big").await.unwrap();
        let data: Vec<u8> = (0..8 * 1024 * 1024u32).map(|i| (i * 7 + i / 251) as u8).collect();
        let d2 = data.clone();
        let writer = tokio::spawn(async move {
            big.write_all(&d2).await.unwrap();
            big.shutdown().await.unwrap();
            big
        });
        let mut stalled = timeout(Duration::from_secs(2), incoming.recv()).await.unwrap().unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;
        // Stream 2 must still work while stream 1 is stuck at its window.
        let mut small = backend.open(b"small").await.unwrap();
        let mut echo = timeout(Duration::from_secs(2), incoming.recv()).await.unwrap().unwrap();
        small.write_all(b"ping").await.unwrap();
        let mut b4 = [0u8; 4];
        timeout(Duration::from_secs(2), echo.stream.read_exact(&mut b4)).await.unwrap().unwrap();
        assert_eq!(&b4, b"ping");
        // Now drain stream 1 and compare every byte.
        let mut got = Vec::new();
        timeout(Duration::from_secs(20), stalled.stream.read_to_end(&mut got)).await.unwrap().unwrap();
        assert_eq!(got.len(), data.len());
        assert!(got == data);
        writer.await.unwrap();
    }

    #[tokio::test]
    async fn closing_the_pipe_ends_every_stream() {
        let ((backend, _), (sandbox, _incoming)) = pair();
        let mut s = backend.open(b"x").await.unwrap();
        sandbox.close();
        timeout(Duration::from_secs(2), backend.closed()).await.unwrap();
        let mut buf = Vec::new();
        let r = timeout(Duration::from_secs(2), s.read_to_end(&mut buf)).await.unwrap();
        assert!(r.is_err() || buf.is_empty());
        assert!(backend.open(b"y").await.is_err());
    }

    #[tokio::test]
    async fn dropping_a_stream_frees_it_on_both_sides() {
        let ((backend, _), (sandbox, incoming)) = pair();
        tokio::spawn(echo_server(incoming));
        for _ in 0..20 {
            let mut s = backend.open(b"x").await.unwrap();
            s.write_all(b"a").await.unwrap();
            let mut b = [0u8; 1];
            s.read_exact(&mut b).await.unwrap();
            drop(s);
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(backend.streams(), 0);
        assert_eq!(sandbox.streams(), 0);
    }

    /// A misbehaving sandbox (any process can write to the pipe) gets the pipe closed, nothing more.
    #[tokio::test]
    async fn protocol_violations_close_the_tunnel() {
        let frame = |kind: u8, id: u32, payload: &[u8]| {
            let mut v = vec![kind];
            v.extend(id.to_be_bytes());
            v.extend((payload.len() as u32).to_be_bytes());
            v.extend(payload);
            v
        };
        // 1. Data beyond the window.
        let (mut evil, b) = tokio::io::duplex(1 << 20);
        let (br, bw) = tokio::io::split(b);
        let (backend, mut inc) = Mux::start(br, bw, Side::Backend);
        evil.write_all(&frame(OPEN, 1, b"proxy")).await.unwrap();
        let _held = inc.recv().await.unwrap();
        for _ in 0..5 {
            evil.write_all(&frame(DATA, 1, &[0u8; 64 * 1024])).await.unwrap();
        }
        timeout(Duration::from_secs(2), backend.closed()).await.unwrap();

        // 2. Oversized frame, 3. wrong stream parity, 4. unknown kind.
        for bad in [
            {
                let mut v = vec![DATA, 0, 0, 0, 1];
                v.extend((MAX_PAYLOAD + 1).to_be_bytes());
                v
            },
            frame(OPEN, 2, b"proxy"),
            frame(99, 1, b""),
        ] {
            let (mut evil, b) = tokio::io::duplex(1 << 20);
            let (br, bw) = tokio::io::split(b);
            let (backend, _inc) = Mux::start(br, bw, Side::Backend);
            evil.write_all(&bad).await.unwrap();
            timeout(Duration::from_secs(2), backend.closed()).await.unwrap();
        }
    }

    #[tokio::test]
    async fn stream_limit() {
        let ((backend, _), (_sandbox, incoming)) = pair();
        tokio::spawn(echo_server(incoming));
        let mut held = Vec::new();
        for _ in 0..MAX_STREAMS {
            held.push(backend.open(b"x").await.unwrap());
        }
        assert!(backend.open(b"x").await.is_err());
    }
}
