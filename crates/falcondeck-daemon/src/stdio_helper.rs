//! Process-role dispatch for stdio helpers hosted by the daemon binary.
//!
//! The packaged desktop embeds the daemon, so built-in connectors execute the
//! desktop binary too. Keep helper recognition here so the standalone daemon
//! and desktop shell cannot drift and accidentally launch a GUI for an MCP
//! subprocess.

use std::ffi::OsStr;

/// A reserved stdio helper process hosted by FalconDeck.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StdioHelper {
    /// The built-in FalconDeck control server.
    Control,
    /// The bridge exposing enabled extension tools to agent harnesses.
    Extensions,
    /// A reserved helper name this build does not understand.
    Unknown(String),
}

/// Classifies the first process argument when it belongs to FalconDeck's
/// reserved MCP-helper namespace. Ordinary GUI and daemon arguments return
/// `None`.
pub fn from_first_arg(arg: Option<&OsStr>) -> Option<StdioHelper> {
    let arg = arg?.to_str()?;
    match arg {
        "mcp" => Some(StdioHelper::Control),
        "mcp-extensions" => Some(StdioHelper::Extensions),
        unknown if unknown.starts_with("mcp-") => Some(StdioHelper::Unknown(unknown.to_string())),
        _ => None,
    }
}

/// Runs one classified helper and returns its process exit code.
pub async fn run(helper: StdioHelper) -> i32 {
    match helper {
        StdioHelper::Control => crate::control::mcp::run_mcp_server().await,
        StdioHelper::Extensions => crate::extension_mcp::run_extension_mcp_server().await,
        StdioHelper::Unknown(command) => {
            eprintln!("falcondeck: unknown helper subcommand {command:?}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_every_supported_helper() {
        assert_eq!(
            from_first_arg(Some(OsStr::new("mcp"))),
            Some(StdioHelper::Control)
        );
        assert_eq!(
            from_first_arg(Some(OsStr::new("mcp-extensions"))),
            Some(StdioHelper::Extensions)
        );
    }

    #[test]
    fn reserves_unknown_mcp_helpers_instead_of_launching_the_app() {
        assert_eq!(
            from_first_arg(Some(OsStr::new("mcp-future"))),
            Some(StdioHelper::Unknown("mcp-future".to_string()))
        );
    }

    #[test]
    fn ignores_normal_process_arguments() {
        assert_eq!(from_first_arg(None), None);
        assert_eq!(from_first_arg(Some(OsStr::new("--version"))), None);
        assert_eq!(from_first_arg(Some(OsStr::new("-psn_0_12345"))), None);
    }
}
