//! Writing a file another program is holding for a moment.
//!
//! On Windows a write fails outright while another process has the file open
//! without write sharing, or has it memory-mapped: a dev server, a type
//! checker's watcher, an editor, an indexer. Those holds last milliseconds.
//! On 2026-10-04 a `file_edit` failed with os error 1224 ("a user-mapped
//! section open"), the model spent a call confirming nothing was damaged, and
//! the identical retry succeeded. Retrying here is what an editor's save does,
//! and the model should never have to.
//!
//! Only lock errors are retried. A missing directory, a permission refusal or
//! a full disk will not clear by waiting and fails at once.

use std::path::Path;
use std::time::Duration;

/// Waits between attempts. Four attempts across ~0.6 s in total: long enough
/// for a watcher to finish reading, short enough that a file locked for good
/// fails while the turn is still moving. Callers run on a blocking thread.
const BACKOFF: [Duration; 3] = [
    Duration::from_millis(80),
    Duration::from_millis(160),
    Duration::from_millis(320),
];

/// `ERROR_SHARING_VIOLATION`, `ERROR_LOCK_VIOLATION`, `ERROR_USER_MAPPED_FILE`.
const TRANSIENT_LOCK_CODES: [i32; 3] = [32, 33, 1224];

/// Is this a hold another process will release, rather than a refusal?
pub(crate) fn is_transient_lock(error: &std::io::Error) -> bool {
    cfg!(windows)
        && error
            .raw_os_error()
            .is_some_and(|code| TRANSIENT_LOCK_CODES.contains(&code))
}

/// `std::fs::write`, retried while the file is briefly held elsewhere.
pub(crate) fn write_retrying_lock(
    path: impl AsRef<Path>,
    contents: impl AsRef<[u8]>,
) -> std::io::Result<()> {
    retry_while_locked(
        || std::fs::write(path.as_ref(), contents.as_ref()),
        std::thread::sleep,
    )
}

fn retry_while_locked<Write, Sleep>(mut write: Write, mut sleep: Sleep) -> std::io::Result<()>
where
    Write: FnMut() -> std::io::Result<()>,
    Sleep: FnMut(Duration),
{
    let mut waits = BACKOFF.iter();
    loop {
        match write() {
            Err(error) if is_transient_lock(&error) => match waits.next() {
                Some(wait) => sleep(*wait),
                None => return Err(error),
            },
            other => return other,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn os_error(code: i32) -> std::io::Error {
        std::io::Error::from_raw_os_error(code)
    }

    #[cfg(windows)]
    #[test]
    fn a_lock_that_clears_is_written_without_an_error() {
        let attempts = Cell::new(0);
        let result = retry_while_locked(
            || {
                attempts.set(attempts.get() + 1);
                if attempts.get() < 3 {
                    Err(os_error(1224))
                } else {
                    Ok(())
                }
            },
            |_| {},
        );
        assert!(result.is_ok());
        assert_eq!(attempts.get(), 3);
    }

    #[cfg(windows)]
    #[test]
    fn a_lock_that_never_clears_fails_after_the_last_wait() {
        let attempts = Cell::new(0);
        let result = retry_while_locked(
            || {
                attempts.set(attempts.get() + 1);
                Err(os_error(32))
            },
            |_| {},
        );
        assert_eq!(result.unwrap_err().raw_os_error(), Some(32));
        assert_eq!(attempts.get(), BACKOFF.len() + 1);
    }

    #[test]
    fn a_refusal_is_not_retried() {
        let attempts = Cell::new(0);
        let result = retry_while_locked(
            || {
                attempts.set(attempts.get() + 1);
                // ERROR_ACCESS_DENIED: waiting will not change it.
                Err(os_error(5))
            },
            |_| {},
        );
        assert!(result.is_err());
        assert_eq!(attempts.get(), 1);
    }
}
