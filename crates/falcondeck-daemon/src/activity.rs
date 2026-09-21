//! Last-activity marker shared by warm agent runtimes.
//!
//! A warm runtime (an ACP agent process, an `opencode serve`) is useful for
//! follow-up turns and pure overhead once nothing has used it for a while.
//! Deciding that needs one fact the runtimes did not previously record: when
//! they last did work. Retirement policy lives in `app::runtime_health`; this
//! is only the clock it reads.

use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Monotonic "last used" timestamp for one runtime.
///
/// A blocking mutex rather than an atomic because `Instant` is not a plain
/// integer and the alternative (millis since an arbitrary base) buys nothing:
/// the lock is held for one store, and it is taken on message traffic rather
/// than per byte.
#[derive(Debug)]
pub struct ActivityClock(Mutex<Instant>);

impl Default for ActivityClock {
    fn default() -> Self {
        Self::new()
    }
}

impl ActivityClock {
    pub fn new() -> Self {
        Self(Mutex::new(Instant::now()))
    }

    /// Marks the runtime as used right now.
    pub fn touch(&self) {
        *self.lock() = Instant::now();
    }

    /// How long since the last [`Self::touch`].
    pub fn idle_for(&self) -> Duration {
        self.lock().elapsed()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Instant> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_clock_starts_idle_at_zero() {
        assert!(ActivityClock::new().idle_for() < Duration::from_secs(1));
    }

    #[test]
    fn touching_resets_the_idle_window() {
        let clock = ActivityClock::new();
        std::thread::sleep(Duration::from_millis(20));
        let before = clock.idle_for();
        clock.touch();
        assert!(clock.idle_for() < before);
    }
}
