use axum::{routing::get, Json, Router};
// use axum::http::StatusCode;
use crate::state::AppState;
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Serialize, ToSchema)]
pub struct HealthStatus {
    pub ok: bool,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

#[utoipa::path(
    get,
    path = "/health",
    tag = "health",
    responses(
        (status = 200, description = "Service healthy", body = HealthStatus)
    )
)]
pub async fn health() -> Json<HealthStatus> {
    Json(HealthStatus { ok: true })
}

