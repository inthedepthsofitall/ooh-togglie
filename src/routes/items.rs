use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use serde::{Deserialize, Serialize};
use tracing::error;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::state::AppState;

#[derive(Serialize, Deserialize, ToSchema)]
pub struct Item {
    pub id: Uuid,
    pub name: String,
    pub risk_score: i32,
    pub risk_level: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct NewItem {
    pub name: String,
}

pub fn router() -> Router<AppState> {
    Router::new().route("/v1/items", get(list_items).post(create_item))
}

#[derive(sqlx::FromRow)]
struct ItemRow {
    id: Uuid,
    name: String,
}

fn compute_risk(name: &str) -> (i32, String) {
    let lower = name.to_ascii_lowercase();

    let score = if lower.contains("test") || lower.contains("dummy") {
        10
    } else if lower.contains("fraud") || lower.contains("scam") {
        90
    } else if lower.contains("risky") || lower.contains("flag") {
        70
    } else {
        30
    };

    let level = if score >= 80 {
        "HIGH"
    } else if score >= 50 {
        "MEDIUM"
    } else {
        "LOW"
    }
    .to_string();

    (score, level)
}

#[utoipa::path(
    get,
    path = "/v1/items",
    tag = "items",
    responses((status = 200, description = "List items", body = [Item]))
)]
pub async fn list_items(
    State(state): State<AppState>,
) -> Result<Json<Vec<Item>>, (StatusCode, String)> {
    let rows: Vec<ItemRow> = sqlx::query_as::<_, ItemRow>(
        r#"SELECT id, name FROM items ORDER BY created_at DESC LIMIT 100"#
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| {
        error!("list_items failed: {e}");
        (StatusCode::INTERNAL_SERVER_ERROR, "db_error".to_string())
    })?;

    let items = rows
        .into_iter()
        .map(|r| {
            let (risk_score, risk_level) = compute_risk(&r.name);
            Item {
                id: r.id,
                name: r.name,
                risk_score,
                risk_level,
            }
        })
        .collect();

    Ok(Json(items))
}

#[utoipa::path(
    post,
    path = "/v1/items",
    request_body = NewItem,
    tag = "items",
    responses((status = 200, description = "Created", body = Item))
)]
pub async fn create_item(
    State(state): State<AppState>,
    Json(body): Json<NewItem>,
) -> Result<Json<Item>, (StatusCode, String)> {
    let id = Uuid::new_v4();
    let (risk_score, risk_level) = compute_risk(&body.name);

    sqlx::query(r#"INSERT INTO items (id, name) VALUES ($1, $2)"#)
        .bind(id)
        .bind(&body.name)
        .execute(&state.pool)
        .await
        .map_err(|e| {
            error!("create_item insert failed: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "db_error".to_string())
        })?;

    Ok(Json(Item {
        id,
        name: body.name,
        risk_score,
        risk_level,
    }))
}
