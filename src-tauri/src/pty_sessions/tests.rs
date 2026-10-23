use super::*;

/// The plugin decoded each read on its own; a character cut by the read
/// boundary came out as replacement marks.
#[test]
fn a_character_split_across_reads_is_kept_whole() {
    let bytes = "ünï 😀 β".as_bytes();
    let mut pending = bytes[..7].to_vec(); // cuts the emoji
    let first = take_complete_utf8(&mut pending);
    pending.extend_from_slice(&bytes[7..]);
    let second = take_complete_utf8(&mut pending);
    assert_eq!(format!("{first}{second}"), "ünï 😀 β");
    assert!(pending.is_empty());
}

#[test]
fn invalid_bytes_are_replaced_and_do_not_stall_the_stream() {
    let mut pending = vec![b'a', 0xFF, b'b'];
    assert_eq!(take_complete_utf8(&mut pending), "a\u{FFFD}b");
    assert!(pending.is_empty());
}

#[cfg(target_os = "windows")]
fn cmd_session(command: &str) -> Arc<Session> {
    spawn(Spawn {
        exe: "cmd.exe",
        args: &["/d".into(), "/c".into(), command.into()],
        env: &[],
        cols: 120,
        rows: 30,
        info: SessionInfo {
            title: "test".into(),
            shell: "cmd".into(),
            cwd: None,
            owner_thread: None,
            command: None,
        },
        channel: None,
    })
    .expect("session opens")
}

#[cfg(target_os = "windows")]
fn pid_alive(pid: u32) -> bool {
    let out = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
}

/// The reported bug, end to end: a process the tab started outlived the tab.
/// `start /b` leaves ping running after its parent cmd has exited, so no
/// parent-pid walk from the shell can reach it. Closing the session must.
///
/// No window is attached, so this also proves Rust answers the pseudo
/// console's cursor query: without that answer cmd never starts the pings.
#[cfg(target_os = "windows")]
#[test]
fn closing_a_session_stops_what_its_shell_started_even_through_a_dead_parent() {
    let session =
        cmd_session("start /b ping -n 120 127.0.0.1 >nul & ping -n 120 127.0.0.1 >nul");
    std::thread::sleep(Duration::from_millis(1800));

    let running = session.running_children().unwrap();
    let pings: Vec<u32> = running
        .iter()
        .filter(|child| child.name.eq_ignore_ascii_case("PING.EXE"))
        .map(|child| child.pid)
        .collect();
    assert_eq!(pings.len(), 2, "both pings are members: {running:?}");

    let id = session.id;
    drop(session);
    kill(id).expect("kill");
    std::thread::sleep(Duration::from_millis(500));
    for pid in pings {
        assert!(!pid_alive(pid), "ping {pid} survived the close");
    }
}

/// What the agent reads is the screen as text, and the exit code is kept.
#[cfg(target_os = "windows")]
#[test]
fn a_finished_session_reads_as_text_and_keeps_its_exit_code() {
    let session = cmd_session("echo hello from aurora & exit 3");
    assert!(session.settle(Duration::from_millis(400), Duration::from_secs(10)));
    let deadline = Instant::now() + Duration::from_secs(5);
    while session.running() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!session.running());
    assert_eq!(session.exit_code(), Some(3));
    let read = session.read(screen::Scope::All, 40, 40);
    assert!(read.text.contains("hello from aurora"), "{:?}", read.text);
    let _ = kill(session.id);
}
