//! Is Aurora running?
//!
//! `aurora agent` needs the answer before it dispatches: if the app is up, the
//! task will be claimed in milliseconds; if it is not, the CLI has to start it
//! first, and should say so rather than leaving the user watching a file that
//! nothing is writing.
//!
//! The mechanism is a named system primitive held for the app's lifetime — a
//! mutex on Windows, an abstract socket on Linux, an `flock` on macOS, all
//! behind `single-instance`. The running app takes it at startup with
//! [`hold`]; a CLI process asks about it with [`aurora_is_running`].
//!
//! ## Why not a pid file
//!
//! A pid file has to answer "is this pid still alive, and is it *Aurora*, or
//! did the OS recycle the number onto something else?" — and it has to survive
//! a crash that leaves the file behind. The kernel already answers all of that
//! for a named primitive: it is released when the holding process dies,
//! however it dies. There is no stale state to reason about.
//!
//! ## What this does not tell you
//!
//! Only that the *process* is up. Not that the Agent Window is open, and not
//! that it is scoped to the right project. Those are the window's business,
//! and a dispatched task is addressed to a workspace rather than to a window
//! precisely so it does not need to know.

use single_instance::SingleInstance;

/// Name of the primitive Aurora holds while it runs.
///
/// Versioned so a future change to what the guard *means* cannot be
/// misread by an older build still checking the old name.
const PRESENCE_KEY: &str = "aurora-ide-v1";

/// Take the presence guard. Called once by the app at startup.
///
/// The returned value must be kept alive for as long as the app runs —
/// dropping it releases the primitive and every CLI check immediately starts
/// reporting that Aurora is not running.
///
/// `None` means the guard could not be created at all (an OS refusing the
/// name). That is not fatal for the app: the only consequence is that
/// `aurora agent` may launch a second instance it did not need to, which is
/// visibly wrong but not destructive — where refusing to boot over it would
/// be.
///
/// A returned guard does **not** prove this process owns the name.
/// `SingleInstance::new` reports "already taken" as a successful construction
/// holding no handle, distinguishable only through `is_single()`. That is the
/// right behaviour here — if another Aurora already advertises presence, this
/// one has nothing to add and must not fail over it — but it means the value
/// is a presence *participant*, not a lock, and nothing should treat it as
/// mutual exclusion.
#[must_use]
pub fn hold() -> Option<SingleInstance> {
    SingleInstance::new(PRESENCE_KEY).ok()
}

/// Whether an Aurora process is currently running.
///
/// Checking is non-destructive: this acquires the primitive if it is free and
/// releases it again on return, so asking never prevents the app from starting
/// afterwards.
#[must_use]
pub fn aurora_is_running() -> bool {
    match SingleInstance::new(PRESENCE_KEY) {
        // We got it, so nobody else holds it — Aurora is not running. The
        // guard drops here, releasing the name immediately.
        Ok(instance) => !instance.is_single(),
        // The name exists but could not be opened. Treating this as "running"
        // is the safer default: the cost of a wrong `true` is a task that
        // waits and then times out with a clear message, while a wrong `false`
        // launches a duplicate Aurora on top of a healthy one.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The whole presence lifecycle, as **one** test.
    ///
    /// Deliberately not split. The guard is a process-global OS primitive, and
    /// `cargo test` runs tests on parallel threads — two tests each taking and
    /// releasing this name would interleave, and one would observe the other's
    /// release as its own. That is not a hypothetical: splitting these is
    /// exactly what made this suite fail intermittently.
    #[test]
    fn presence_lifecycle() {
        // A real Aurora running on this machine owns the name already, so the
        // suite cannot take it and the assertions below would be measuring the
        // developer's desktop rather than the code.
        if aurora_is_running() {
            return;
        }

        // Checking must not consume the name: two reads in a row agree, and
        // the app can still take it afterwards.
        assert!(!aurora_is_running());
        assert!(!aurora_is_running());

        let guard = hold().expect("the name was free, so it must be holdable");
        assert!(
            guard.is_single(),
            "hold() must actually own the name, not return a hollow guard"
        );
        assert!(
            aurora_is_running(),
            "a held guard must read as `running` from a checker"
        );
        // Repeated checks while held must not release it.
        assert!(aurora_is_running());

        drop(guard);
        assert!(
            !aurora_is_running(),
            "releasing the guard must read as `not running`"
        );
    }
}
