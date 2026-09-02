use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum DaemonError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Rpc(String),
    #[error("{0}")]
    Process(String),
    #[error(
        "ACP provider '{provider}' did not respond to {method} within {timeout_seconds} seconds"
    )]
    AcpRequestTimeout {
        provider: String,
        method: String,
        timeout_seconds: u64,
    },
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for DaemonError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::NotFound(_) => StatusCode::NOT_FOUND,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Rpc(_)
            | Self::Process(_)
            | Self::AcpRequestTimeout { .. }
            | Self::Io(_)
            | Self::Json(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };

        (
            status,
            Json(ErrorBody {
                error: self.to_string(),
            }),
        )
            .into_response()
    }
}
