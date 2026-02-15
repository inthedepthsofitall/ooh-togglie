use axum::Router;
use crate::state::AppState;

pub mod health;
pub mod items;

pub fn router() -> Router<AppState> {
    Router::new()
        .merge(health::router())
        .merge(items::router())
}
