//! Fixed-size logging budget; never retains request identifiers or payloads.
use std::time::{Duration, Instant};

pub(crate) struct SlowRpcLogBudget {
    window: Instant,
    emitted: u8,
    suppressed: u64,
}

impl Default for SlowRpcLogBudget {
    fn default() -> Self {
        Self {
            window: Instant::now(),
            emitted: 0,
            suppressed: 0,
        }
    }
}

impl SlowRpcLogBudget {
    /// Ten slow replies per minute per requester connection. The next emitted
    /// diagnostic reports how many were suppressed in the previous window.
    pub(crate) fn take(&mut self, now: Instant) -> Option<u64> {
        if now.duration_since(self.window) >= Duration::from_secs(60) {
            self.window = now;
            self.emitted = 0;
        }
        if self.emitted >= 10 {
            self.suppressed = self.suppressed.saturating_add(1);
            return None;
        }
        self.emitted += 1;
        Some(std::mem::take(&mut self.suppressed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn burst_is_bounded_and_suppression_is_reported_on_recovery() {
        let mut budget = SlowRpcLogBudget::default();
        let start = budget.window;
        for _ in 0..10 {
            assert_eq!(budget.take(start), Some(0));
        }
        for _ in 0..100 {
            assert_eq!(budget.take(start + Duration::from_secs(59)), None);
        }
        assert_eq!(budget.take(start + Duration::from_secs(60)), Some(100));
        assert_eq!(budget.take(start + Duration::from_secs(60)), Some(0));
    }
}
