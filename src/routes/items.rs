use axum::{extract::State, routing::{get, post}, Json, Router};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use crate::state::AppState;

#[derive(Serialize, Deserialize, utoipa::ToSchema)]
pub struct Item { pub id: Uuid, pub name: String }


#[derive(Serialize, Deserialize, utoipa::ToSchema)]
pub struct NewItem { pub name: String }

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/items", get(list_items).post(create_item))
}

#[utoipa::path(get, path = "/v1/items", tag = "items")]
pub async fn list_items(State(state): State<AppState>) -> Json<Vec<Item>> {
// MVP: simple SELECT demo; create a table first
let rows = sqlx::query!("SELECT id, name FROM items ORDER BY created_at DESC LIMIT 100")
    .fetch_all(&state.pool).await;


    let items = match rows {
    Ok(rs) => rs.into_iter().map(|r| Item { id: r.id, name: r.name }).collect(),
    Err(_) => vec![],
    };
    Json(items)
}


#[utoipa::path(post, path = "/v1/items", request_body = NewItem, tag = "items")]
pub async fn create_item(State(state): State<AppState>, Json(body): Json<NewItem>) -> Json<Item> {
    let id = Uuid::new_v4();
    let _ = sqlx::query!("INSERT INTO items (id, name) VALUES ($1, $2)", id, body.name)
    .execute(&state.pool).await;
    Json(Item { id, name: body.name })
}