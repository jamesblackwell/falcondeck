use axum::{
    Json,
    http::{HeaderValue, StatusCode, header::RETRY_AFTER},
    response::{IntoResponse, Response},
};
use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum RelayError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    TooManyRequests(String),
    #[error("failed to load relay state: {0}")]
    StateLoad(String),
    #[error("failed to persist relay state: {0}")]
    StatePersist(String),
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

impl IntoResponse for RelayError {
    fn into_response(self) -> Response {
        let status = match &self {
            RelayError::BadRequest(_) => StatusCode::BAD_REQUEST,
            RelayError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            RelayError::NotFound(_) => StatusCode::NOT_FOUND,
            RelayError::Conflict(_) => StatusCode::CONFLICT,
            RelayError::TooManyRequests(_) => StatusCode::TOO_MANY_REQUESTS,
            RelayError::StateLoad(_) | RelayError::StatePersist(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };

        let body = Json(ErrorBody {
            error: self.to_string(),
        });

        let mut response = (status, body).into_response();
        if status == StatusCode::TOO_MANY_REQUESTS {
            response
                .headers_mut()
                .insert(RETRY_AFTER, HeaderValue::from_static("6"));
        }
        response
    }
}
