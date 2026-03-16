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
    Rpc(String),
    #[error("{0}")]
    Process(String),
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
            Self::Rpc(_) | Self::Process(_) | Self::Io(_) | Self::Json(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
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
