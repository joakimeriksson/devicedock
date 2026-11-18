//! `devicedock pipe <port>`: the sandbox end of the `codex login` callback relay joins stdin and stdout to a local port.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::process::{Command, Stdio};

#[test]
fn pipe_carries_a_request_and_its_reply_then_exits() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut c, _) = listener.accept().unwrap();
        let mut req = Vec::new();
        c.read_to_end(&mut req).unwrap(); // ends when the pipe's stdin ends (half-close)
        c.write_all(b"HTTP/1.0 200 OK\r\n\r\nlogged in").unwrap();
        req
    });
    let mut child = Command::new(env!("CARGO_BIN_EXE_devicedock"))
        .args(["pipe", &port.to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(b"GET /auth/callback?code=x HTTP/1.0\r\n\r\n").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    assert_eq!(out.stdout, b"HTTP/1.0 200 OK\r\n\r\nlogged in");
    assert_eq!(server.join().unwrap(), b"GET /auth/callback?code=x HTTP/1.0\r\n\r\n");
}

#[test]
fn pipe_exits_1_when_nothing_listens() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port(); // bound, then freed
    let s = Command::new(env!("CARGO_BIN_EXE_devicedock")).args(["pipe", &port.to_string()]).stdin(Stdio::null()).status().unwrap();
    assert_eq!(s.code(), Some(1));
}
