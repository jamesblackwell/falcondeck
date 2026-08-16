//! Daemon-owned agent control service.
//!
//! The control service owns capability discovery (`search`), reads (`get`)
//! and mutations (`execute`) for the agent control interface. It is the one
//! source of behaviour: the MCP adapter and desktop UI call these methods
//! over the loopback control API and never touch the store directly.
//!
//! Layout:
//!
//! - [`registry`] — capability catalogue and deterministic search
//! - [`store`] — persistence, bounds, migrations, cursors, projections
//! - [`automations`] — schedule validation and occurrence calculation
//! - [`redaction`] — structured secret redaction for model-facing output

pub mod automations;
pub mod redaction;
pub mod registry;
pub mod store;

mod service;

pub use service::{
    ControlDeps, ControlError, ControlService, MAX_CONCURRENT_AUTOMATION_RUNS, RunSource,
};

#[cfg(test)]
mod tests;
