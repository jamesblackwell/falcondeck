//! Relay service for `FalconDeck` remote and paired-device sessions.
//!
//! The relay keeps encrypted session replay, trusted-device state, and the
//! websocket/http endpoints that let remote clients reconnect to a running
//! daemon without becoming the source of truth for conversations.

pub mod api;
pub mod app;
pub mod error;
pub(crate) mod persistence;

pub use api::router;
pub use app::{AppState, RetentionConfig};
