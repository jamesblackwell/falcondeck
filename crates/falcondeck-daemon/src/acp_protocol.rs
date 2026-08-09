//! Shared classification for ACP protocol values used by production ingestion
//! and compatibility diagnostics.

/// What FalconDeck currently does with one ACP `session/update` kind.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcpUpdateDisposition {
    /// Produces a conversation event visible to clients.
    Projected,
    /// Updates daemon state or is deliberately suppressed.
    Consumed,
    /// Recognized ACP data for which FalconDeck has no projection yet.
    KnownUnhandled,
    /// A value unknown to this FalconDeck build, usually indicating drift.
    Unknown,
}

/// Classified ACP `session/update` discriminant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AcpSessionUpdateKind<'a> {
    AgentMessageChunk,
    AgentThoughtChunk,
    CurrentModeUpdate,
    ToolCall,
    ToolCallUpdate,
    Plan,
    AvailableCommandsUpdate,
    SessionInfoUpdate,
    UsageUpdate,
    UserMessageChunk,
    Unknown(&'a str),
}

impl<'a> AcpSessionUpdateKind<'a> {
    /// Classifies a wire-protocol discriminant without allocating.
    pub fn classify(kind: &'a str) -> Self {
        match kind {
            "agent_message_chunk" => Self::AgentMessageChunk,
            "agent_thought_chunk" => Self::AgentThoughtChunk,
            "current_mode_update" => Self::CurrentModeUpdate,
            "tool_call" => Self::ToolCall,
            "tool_call_update" => Self::ToolCallUpdate,
            "plan" => Self::Plan,
            "available_commands_update" => Self::AvailableCommandsUpdate,
            "session_info_update" => Self::SessionInfoUpdate,
            "usage_update" => Self::UsageUpdate,
            "user_message_chunk" => Self::UserMessageChunk,
            unknown => Self::Unknown(unknown),
        }
    }

    /// Returns the exact discriminant used on the wire.
    pub fn as_str(self) -> &'a str {
        match self {
            Self::AgentMessageChunk => "agent_message_chunk",
            Self::AgentThoughtChunk => "agent_thought_chunk",
            Self::CurrentModeUpdate => "current_mode_update",
            Self::ToolCall => "tool_call",
            Self::ToolCallUpdate => "tool_call_update",
            Self::Plan => "plan",
            Self::AvailableCommandsUpdate => "available_commands_update",
            Self::SessionInfoUpdate => "session_info_update",
            Self::UsageUpdate => "usage_update",
            Self::UserMessageChunk => "user_message_chunk",
            Self::Unknown(kind) => kind,
        }
    }

    /// Returns how production ingestion treats this update kind.
    pub fn disposition(self) -> AcpUpdateDisposition {
        match self {
            Self::AgentMessageChunk | Self::ToolCall | Self::ToolCallUpdate | Self::Plan => {
                AcpUpdateDisposition::Projected
            }
            Self::AgentThoughtChunk | Self::CurrentModeUpdate => AcpUpdateDisposition::Consumed,
            Self::AvailableCommandsUpdate
            | Self::SessionInfoUpdate
            | Self::UsageUpdate
            | Self::UserMessageChunk => AcpUpdateDisposition::KnownUnhandled,
            Self::Unknown(_) => AcpUpdateDisposition::Unknown,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_projected_consumed_unhandled_and_unknown_updates() {
        assert_eq!(
            AcpSessionUpdateKind::classify("tool_call").disposition(),
            AcpUpdateDisposition::Projected
        );
        assert_eq!(
            AcpSessionUpdateKind::classify("agent_thought_chunk").disposition(),
            AcpUpdateDisposition::Consumed
        );
        assert_eq!(
            AcpSessionUpdateKind::classify("usage_update").disposition(),
            AcpUpdateDisposition::KnownUnhandled
        );
        assert_eq!(
            AcpSessionUpdateKind::classify("future_update").disposition(),
            AcpUpdateDisposition::Unknown
        );
    }

    #[test]
    fn unknown_update_round_trips_without_allocation() {
        let kind = AcpSessionUpdateKind::classify("provider_extension");
        assert_eq!(kind.as_str(), "provider_extension");
    }
}
