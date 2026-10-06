//! Refinements for the qualified Hermes ACP adapter; native storage stays in Hermes.
use std::collections::HashSet;

use falcondeck_core::CollaborationModeSummary;

use crate::error::DaemonError;

pub(super) fn label_edit_modes(modes: &mut [CollaborationModeSummary]) {
    for mode in modes {
        let label = match mode.id.as_str() {
            "default" => "Ask before edits",
            "accept_edits" => "Accept edits",
            "dont_ask" => "Don't ask before edits",
            _ => continue,
        };
        mode.label = label.to_owned();
    }
}

pub(super) fn is_command(command: &str, advertised: Option<&HashSet<String>>) -> bool {
    let command = command.to_ascii_lowercase();
    if let Some(advertised) = advertised {
        return advertised.contains(&command);
    }
    // Both qualified adapters send their command inventory asynchronously
    // after new/load. These shared commands also work before that update.
    matches!(
        command.as_str(),
        "help"
            | "model"
            | "tools"
            | "context"
            | "reset"
            | "compress"
            | "steer"
            | "queue"
            | "version"
    )
}

pub(super) fn with_context(text: String, context: Option<&str>) -> Result<String, DaemonError> {
    let Some(context) = context.filter(|context| !context.trim().is_empty()) else {
        return Ok(text);
    };
    // Refuse oversized context rather than silently losing host guidance.
    if context.len() > 64 * 1024 {
        return Err(DaemonError::BadRequest(
            "Hermes host guidance exceeds 64 KiB".into(),
        ));
    }
    // This existing projection tag hides host guidance from echoed/replayed
    // user messages. Repeating it each turn survives compression and reload
    // without modifying Hermes memory, configuration, or project instructions.
    Ok(format!(
        "<system-reminder>\n{context}\n</system-reminder>\n\n{text}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guidance_is_bounded() {
        let text = with_context("Visible user".into(), Some("FalconDeck host guidance")).unwrap();
        assert!(text.starts_with("<system-reminder>"));
        assert!(text.ends_with("Visible user"));
        assert!(with_context("user".into(), Some(&"x".repeat(65537))).is_err());
        assert_eq!(with_context("user".into(), None).unwrap(), "user");
    }
}
