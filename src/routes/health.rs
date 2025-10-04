use axum::{routing::get, Router};
use axum::http::StatusCode;

pub fn router() -> Router {
    Router::new().route("/health", get(health))
}

#[utopia::path(get, path = "/health")]
pub async fn health() -> StatusCode { StatusCode::OK }

