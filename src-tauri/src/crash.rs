//! Crash-time diagnostics — the log that gets written when logging itself
//! cannot be trusted.
//!
//! [`crate::logging`] handles every failure the process *survives*. This module
//! handles the ones it does not: a stack overflow, an access violation, an
//! abort. Those never reach a panic hook — they are Windows SEH exceptions that
//! terminate the process — so before this existed a fatal crash left
//! `aurora.log` ending mid-session with no reason recorded, and the only
//! evidence was a Windows event-log row naming an exception code.
//!
//! ## Why this does not reuse `logging::write_entry`
//!
//! A stack overflow leaves roughly one page of stack. `write_entry` formats with
//! `format!`, opens a file, and takes a `Mutex` — allocation can call back into
//! the allocator's own locks, and the mutex may already be held by the very
//! thread that is crashing. Any of those turns a diagnosable crash into a hang
//! or a second fault. So the fatal path here:
//!
//! - writes through a **handle opened at install time**, never opening a file;
//! - formats into a **fixed stack buffer** with no allocator involvement;
//! - takes **no lock** — a single atomic guards against two threads writing;
//! - captures return addresses with `RtlCaptureStackBackTrace`, which is
//!   allocation-free, rather than `std::backtrace` (which allocates and
//!   symbolizes).
//!
//! ## Reading what it writes
//!
//! Addresses are raw and unsymbolized, because symbolizing at crash time needs
//! the very machinery that is unavailable. Each report therefore records the
//! **module base** alongside them, which is the one fact needed to turn them
//! into function names afterwards: `rva = address - base`, then look the RVA up
//! in the matching `aurora.pdb`. This is exactly the procedure that identified
//! the 2026-08-17 overflow by hand; the point of this module is that the next
//! one does not need a debugger attached and a live process to reproduce.

/// Where fatal reports land. Deliberately NOT `aurora.log`: that file rotates,
/// and a handle opened at install time would keep writing into the renamed
/// backup after a rotation. This one is append-only, tiny, and never rotates.
pub fn crash_file() -> std::path::PathBuf {
    crate::paths::logs_dir().join("aurora-crash.log")
}

/// Install every crash net available on this platform.
///
/// Call once, immediately after [`crate::logging::init`] — the panic hook it
/// installs chains ahead of the logging one, so a panic is recorded by both.
pub fn install() {
    install_panic_backtrace_hook();
    #[cfg(windows)]
    windows_impl::install_at(&crash_file());
}

/// Add a backtrace to the panic record.
///
/// `logging::init` already logs the payload and location, which answers "what"
/// but never "who called it". A panic still has a stack, so unlike the fatal
/// path this one can afford `Backtrace::force_capture` and the allocation it
/// does — and a symbolized backtrace beats a list of hex addresses.
fn install_panic_backtrace_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("<unnamed>").to_string();
        crate::logging::log_error(
            "panic.backtrace",
            &format!("thread '{name}' panicked; backtrace:\n{backtrace}"),
        );
        previous(info);
    }));
}

#[cfg(windows)]
mod windows_impl {
    use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};

    use windows_sys::Win32::Foundation::{
        FILETIME, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, SYSTEMTIME,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, FlushFileBuffers, SetFilePointer, WriteFile, FILE_APPEND_DATA,
        FILE_ATTRIBUTE_NORMAL, FILE_END, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_ALWAYS,
    };
    use windows_sys::Win32::System::Diagnostics::Debug::{
        AddVectoredExceptionHandler, EXCEPTION_POINTERS,
    };

    // `RtlCaptureStackBackTrace` has no windows-sys binding, so declare it. It
    // is the only backtrace API usable here: it walks the frames and returns,
    // touching neither the allocator nor the symbol handler, both of which are
    // off-limits on a stack that has just run out.
    #[link(name = "kernel32")]
    extern "system" {
        fn RtlCaptureStackBackTrace(
            frames_to_skip: u32,
            frames_to_capture: u32,
            back_trace: *mut *mut core::ffi::c_void,
            back_trace_hash: *mut u32,
        ) -> u16;
    }
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::SystemInformation::GetSystemTimeAsFileTime;
    use windows_sys::Win32::System::Threading::{GetCurrentThreadId, SetThreadStackGuarantee};
    use windows_sys::Win32::System::Time::FileTimeToSystemTime;

    /// Codes worth a report. Everything else — breakpoints, the C++ EH code
    /// (`0xE06D7363`), the thread-naming exception (`0x406D1388`) — is either a
    /// debugger artefact or routinely raised and caught during normal running,
    /// and reporting those would fill the file with noise from healthy runs.
    const EXCEPTION_STACK_OVERFLOW: u32 = 0xC000_00FD;
    const EXCEPTION_ACCESS_VIOLATION: u32 = 0xC000_0005;
    const EXCEPTION_ILLEGAL_INSTRUCTION: u32 = 0xC000_001D;
    const EXCEPTION_INT_DIVIDE_BY_ZERO: u32 = 0xC000_0094;
    const EXCEPTION_PRIV_INSTRUCTION: u32 = 0xC000_0096;
    const EXCEPTION_IN_PAGE_ERROR: u32 = 0xC000_0006;

    /// `CALL_FIRST` — run before any other vectored handler and before SEH
    /// unwinding. A stack overflow must be recorded before something else
    /// swallows it or the process dies.
    const CALL_FIRST: u32 = 1;

    /// Stack reserved so the handler itself has somewhere to run when the crash
    /// IS an exhausted stack. Without it Windows has no room to dispatch the
    /// handler and the process dies silently — which is the whole failure this
    /// module exists to end. 64 KiB is far more than the handler's fixed buffer
    /// and a few frames need.
    const HANDLER_STACK_RESERVE: u32 = 64 * 1024;

    /// Frames to capture. `RtlCaptureStackBackTrace` caps below 63 on older
    /// Windows; 62 is the portable maximum and enough to show a recursion cycle
    /// repeating, which is the shape that matters.
    const MAX_FRAMES: usize = 62;

    /// The append handle, opened once at install so the handler never calls
    /// `CreateFileW`. Stored as `isize` because a raw `HANDLE` is a pointer and
    /// cannot be cast in a `const` initializer; [`NO_HANDLE`] is the sentinel
    /// meaning "install failed", and the handler then goes quiet rather than
    /// risking a second fault.
    static CRASH_HANDLE: AtomicIsize = AtomicIsize::new(NO_HANDLE);

    /// `INVALID_HANDLE_VALUE` as an integer. Spelled literally for the same
    /// reason the field above is an `isize`.
    const NO_HANDLE: isize = -1;

    /// Base address of aurora.exe, recorded so the raw return addresses in a
    /// report can be turned into RVAs later.
    static MODULE_BASE: AtomicIsize = AtomicIsize::new(0);

    /// One report per process. A stack overflow can re-fault while the handler
    /// runs, and a handler that re-entered would append forever.
    static REPORTED: AtomicU32 = AtomicU32::new(0);

    /// Arm the handler, writing reports to `path`.
    ///
    /// The path is a parameter rather than read from [`super::crash_file`] so a
    /// test can point a crashing child process at a temp file. Redirecting via
    /// the environment does not work here: `dirs::data_local_dir` resolves
    /// through the Windows known-folder API, which ignores `LOCALAPPDATA`.
    pub fn install_at(path: &std::path::Path) {
        reserve_handler_stack();

        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);

        // SAFETY: `wide` is a NUL-terminated UTF-16 path that outlives the call.
        let handle = unsafe {
            CreateFileW(
                wide.as_ptr(),
                FILE_APPEND_DATA | GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                std::ptr::null(),
                OPEN_ALWAYS,
                FILE_ATTRIBUTE_NORMAL,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE || handle.is_null() {
            crate::logging::log_error(
                "crash.install",
                "could not open the crash-report file; a fatal crash will leave no report",
            );
            return;
        }
        // SAFETY: freshly opened handle; seeking to the end makes every write an
        // append even though the handle is long-lived.
        unsafe { SetFilePointer(handle, 0, std::ptr::null_mut(), FILE_END) };
        CRASH_HANDLE.store(handle as isize, Ordering::SeqCst);

        // SAFETY: null names the running executable.
        let base = unsafe { GetModuleHandleW(std::ptr::null()) };
        MODULE_BASE.store(base as isize, Ordering::SeqCst);

        // SAFETY: `handler` is a valid `extern "system"` callback with the
        // signature the API requires, and it lives for the process lifetime.
        unsafe { AddVectoredExceptionHandler(CALL_FIRST, Some(handler)) };
    }

    /// Give the CURRENT thread room for the handler to run after a stack
    /// overflow. Must be called per thread — a reservation on the main thread
    /// says nothing about a tokio worker, and the overflow that prompted this
    /// module happened on `tokio-runtime-worker`. Public so the runtime's
    /// `on_thread_start` hook can call it for every worker it spawns.
    pub fn reserve_handler_stack() {
        let mut size = HANDLER_STACK_RESERVE;
        // SAFETY: `size` is a valid out-param for the duration of the call.
        unsafe { SetThreadStackGuarantee(&mut size) };
    }

    unsafe extern "system" fn handler(info: *mut EXCEPTION_POINTERS) -> i32 {
        /// `EXCEPTION_CONTINUE_SEARCH` — record and step aside. This handler
        /// never decides the crash's fate; swallowing an exception would turn a
        /// clean abort into corrupted state limping forward.
        const CONTINUE_SEARCH: i32 = 0;

        if info.is_null() {
            return CONTINUE_SEARCH;
        }
        // SAFETY: Windows guarantees a valid record for a dispatched exception.
        let record = unsafe { (*info).ExceptionRecord };
        if record.is_null() {
            return CONTINUE_SEARCH;
        }
        let code = unsafe { (*record).ExceptionCode } as u32;
        let address = unsafe { (*record).ExceptionAddress } as usize;

        if !matches!(
            code,
            EXCEPTION_STACK_OVERFLOW
                | EXCEPTION_ACCESS_VIOLATION
                | EXCEPTION_ILLEGAL_INSTRUCTION
                | EXCEPTION_INT_DIVIDE_BY_ZERO
                | EXCEPTION_PRIV_INSTRUCTION
                | EXCEPTION_IN_PAGE_ERROR
        ) {
            return CONTINUE_SEARCH;
        }
        if REPORTED.swap(1, Ordering::SeqCst) != 0 {
            return CONTINUE_SEARCH;
        }

        let handle = CRASH_HANDLE.load(Ordering::SeqCst);
        if handle == NO_HANDLE {
            return CONTINUE_SEARCH;
        }

        let mut buf = Buf::new();
        buf.str("\n=== AURORA FATAL ");
        write_timestamp(&mut buf);
        buf.str(" ===\nexception: ");
        buf.str(describe(code));
        buf.str(" (0x");
        buf.hex(code as usize);
        buf.str(")\nfaulting address: 0x");
        buf.hex(address);
        buf.str("\nthread id: ");
        // SAFETY: no preconditions.
        buf.dec(unsafe { GetCurrentThreadId() } as usize);
        buf.str("\nmodule base: 0x");
        let base = MODULE_BASE.load(Ordering::SeqCst) as usize;
        buf.hex(base);
        buf.str("\nversion: ");
        buf.str(env!("CARGO_PKG_VERSION"));
        buf.str("\nframes (subtract module base for the RVA to look up in aurora.pdb):\n");
        flush(handle, &mut buf);

        let mut frames: [*mut core::ffi::c_void; MAX_FRAMES] = [std::ptr::null_mut(); MAX_FRAMES];
        // SAFETY: `frames` is a valid buffer of `MAX_FRAMES` pointers.
        let captured = unsafe {
            RtlCaptureStackBackTrace(
                0,
                MAX_FRAMES as u32,
                frames.as_mut_ptr(),
                std::ptr::null_mut(),
            )
        };
        for frame in frames.iter().take(captured as usize) {
            let addr = *frame as usize;
            buf.str("  0x");
            buf.hex(addr);
            if base != 0 && addr > base {
                buf.str("  rva=0x");
                buf.hex(addr - base);
            }
            buf.str("\n");
            flush(handle, &mut buf);
        }
        if captured as usize == MAX_FRAMES {
            buf.str("  … truncated at ");
            buf.dec(MAX_FRAMES);
            buf.str(" frames; a repeating cycle above is a runaway recursion\n");
        }
        buf.str("=== END ===\n");
        flush(handle, &mut buf);
        // SAFETY: valid handle; makes the report survive the imminent death.
        unsafe { FlushFileBuffers(handle as HANDLE) };

        CONTINUE_SEARCH
    }

    fn describe(code: u32) -> &'static str {
        match code {
            EXCEPTION_STACK_OVERFLOW => "STACK_OVERFLOW (runaway recursion)",
            EXCEPTION_ACCESS_VIOLATION => "ACCESS_VIOLATION",
            EXCEPTION_ILLEGAL_INSTRUCTION => "ILLEGAL_INSTRUCTION",
            EXCEPTION_INT_DIVIDE_BY_ZERO => "INT_DIVIDE_BY_ZERO",
            EXCEPTION_PRIV_INSTRUCTION => "PRIV_INSTRUCTION",
            EXCEPTION_IN_PAGE_ERROR => "IN_PAGE_ERROR",
            _ => "UNKNOWN",
        }
    }

    fn write_timestamp(buf: &mut Buf) {
        let mut ft = FILETIME {
            dwLowDateTime: 0,
            dwHighDateTime: 0,
        };
        let mut st = SYSTEMTIME {
            wYear: 0,
            wMonth: 0,
            wDayOfWeek: 0,
            wDay: 0,
            wHour: 0,
            wMinute: 0,
            wSecond: 0,
            wMilliseconds: 0,
        };
        // SAFETY: both are valid out-params; neither call allocates.
        unsafe {
            GetSystemTimeAsFileTime(&mut ft);
            FileTimeToSystemTime(&ft, &mut st);
        }
        buf.dec(st.wYear as usize);
        buf.str("-");
        buf.pad2(st.wMonth as usize);
        buf.str("-");
        buf.pad2(st.wDay as usize);
        buf.str("T");
        buf.pad2(st.wHour as usize);
        buf.str(":");
        buf.pad2(st.wMinute as usize);
        buf.str(":");
        buf.pad2(st.wSecond as usize);
        buf.str("Z");
    }

    fn flush(handle: isize, buf: &mut Buf) {
        if buf.len == 0 {
            return;
        }
        let mut written: u32 = 0;
        // SAFETY: valid handle and a buffer of exactly `len` initialized bytes.
        unsafe {
            WriteFile(
                handle as HANDLE,
                buf.bytes.as_ptr(),
                buf.len as u32,
                &mut written,
                std::ptr::null_mut(),
            );
        }
        buf.len = 0;
    }

    /// Fixed-size formatter. Every method silently drops what will not fit —
    /// a truncated report is worth having; a handler that panics on overflow is
    /// not, and there is no stack to panic on anyway.
    struct Buf {
        bytes: [u8; 1024],
        len: usize,
    }

    impl Buf {
        fn new() -> Self {
            Self {
                bytes: [0; 1024],
                len: 0,
            }
        }

        fn byte(&mut self, b: u8) {
            if self.len < self.bytes.len() {
                self.bytes[self.len] = b;
                self.len += 1;
            }
        }

        fn str(&mut self, s: &str) {
            for b in s.as_bytes() {
                self.byte(*b);
            }
        }

        fn hex(&mut self, mut value: usize) {
            const DIGITS: &[u8; 16] = b"0123456789abcdef";
            let mut tmp = [0u8; 16];
            let mut n = 0;
            if value == 0 {
                self.byte(b'0');
                return;
            }
            while value > 0 && n < tmp.len() {
                tmp[n] = DIGITS[value & 0xf];
                value >>= 4;
                n += 1;
            }
            while n > 0 {
                n -= 1;
                self.byte(tmp[n]);
            }
        }

        fn dec(&mut self, mut value: usize) {
            let mut tmp = [0u8; 20];
            let mut n = 0;
            if value == 0 {
                self.byte(b'0');
                return;
            }
            while value > 0 && n < tmp.len() {
                tmp[n] = b'0' + (value % 10) as u8;
                value /= 10;
                n += 1;
            }
            while n > 0 {
                n -= 1;
                self.byte(tmp[n]);
            }
        }

        fn pad2(&mut self, value: usize) {
            if value < 10 {
                self.byte(b'0');
            }
            self.dec(value);
        }
    }

    use std::os::windows::ffi::OsStrExt as _;
}

#[cfg(windows)]
pub use windows_impl::reserve_handler_stack;

/// No-op on platforms without the Windows SEH nets, so callers need no `cfg`.
#[cfg(not(windows))]
pub fn reserve_handler_stack() {}

/// Env var that turns a test process into the crashing child. Its value is the
/// temp root the child writes its report under.
#[cfg(test)]
const SELFTEST_VAR: &str = "AURORA_CRASH_SELFTEST";

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    /// Burn stack fast. `black_box` keeps the optimizer from turning this into
    /// a loop or eliding the padding, which is what makes the recursion real
    /// rather than a tail call the compiler flattens.
    #[allow(unconditional_recursion)] // the entire point of the fixture
    fn overflow(depth: u64) -> u64 {
        let pad = [depth; 256];
        std::hint::black_box(&pad);
        overflow(std::hint::black_box(depth + 1)).wrapping_add(pad[0])
    }

    /// The whole promise of this module, end to end: kill a process with a
    /// stack overflow and find out why from a file afterwards.
    ///
    /// Runs as two processes because the assertion is about what survives a
    /// process that does not. The child re-executes this same test binary with
    /// `LOCALAPPDATA` pointed at a temp dir, so it writes its report there
    /// instead of into the developer's real log.
    #[test]
    fn a_stack_overflow_writes_a_report_before_the_process_dies() {
        if let Ok(report) = std::env::var(SELFTEST_VAR) {
            // Child: arm the handler, then run out of stack.
            install_panic_backtrace_hook();
            windows_impl::install_at(std::path::Path::new(&report));
            let _ = overflow(0);
            unreachable!("the recursion must not return");
        }

        let temp = tempfile::tempdir().expect("tempdir");
        let report = temp.path().join("aurora-crash.log");
        let exe = std::env::current_exe().expect("current_exe");
        let status = std::process::Command::new(exe)
            .args([
                "--exact",
                "crash::tests::a_stack_overflow_writes_a_report_before_the_process_dies",
                "--nocapture",
            ])
            .env(SELFTEST_VAR, &report)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .expect("spawn child");

        assert!(
            !status.success(),
            "the child was supposed to die: {status:?}"
        );

        let text = std::fs::read_to_string(&report).unwrap_or_else(|e| {
            panic!(
                "a fatal crash must leave a report at {}: {e}",
                report.display()
            )
        });

        assert!(
            text.contains("STACK_OVERFLOW"),
            "the report must name the cause, not just that something happened:\n{text}"
        );
        assert!(
            text.contains("module base: 0x"),
            "without the module base the frame addresses cannot be resolved:\n{text}"
        );
        assert!(
            text.contains("rva=0x"),
            "frames must carry RVAs so they can be looked up in the pdb:\n{text}"
        );
    }
}
