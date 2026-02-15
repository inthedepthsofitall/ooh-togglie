use std::net::SocketAddr;
use tokio::net::TcpListener;

use utoipa::OpenApi;
use axum::{routing::get, Router};
use axum_prometheus::PrometheusMetricLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::{fmt, EnvFilter, prelude::*};


mod routes;
mod state;
mod db;


#[derive(OpenApi)]
#[openapi(
    paths(
        crate::routes::health::health,
        crate::routes::items::list_items,
        crate::routes::items::create_item
    ),
    components(schemas(
        crate::routes::health::HealthStatus,
        crate::routes::items::Item,
        crate::routes::items::NewItem
    )),
    tags(
        (name = "health", description = "Service liveness & readiness"),
        (name = "items", description = "Item CRUD")
    )
)]
struct ApiDoc;



#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing::info!("DATABASE_URL={}", std::env::var("DATABASE_URL").unwrap_or_default());


    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let fmt_layer = fmt::layer().with_target(false);
    tracing_subscriber::registry().with(fmt_layer).with(filter).init();

    let pool = db::init_pool().await?;
    let url = std::env::var("DATABASE_URL")?;
    tracing::info!("DATABASE_URL host={}", url.split('@').nth(1).unwrap_or("unknown"));

    let app_state = state::AppState { pool };

    let (prom_layer, handle) = PrometheusMetricLayer::pair();

    let api = routes::router()
        .route("/metrics", get(move || {
            let h = handle.clone();
            async move { h.render() }
        }));


    let app = Router::new()
        .merge(api)
        .merge(utoipa_swagger_ui::SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .with_state(app_state)
        .layer(prom_layer)
        .layer(TraceLayer::new_for_http());

    let host = std::env::var("APP_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port: u16 = std::env::var("APP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);


    let addr: SocketAddr = format!("{}:{}", host, port)
        .parse()
        .expect("invalid host/port");

    let listener = TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening");

    axum::serve(listener, app).await?;



    Ok(())
}
