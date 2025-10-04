use std::net::SocketAddr;
use axum::{routing::{get, post}, Router};
use axum_prometheus::PrometheusMetricLayer;
use tower::{ServiceBuilder, limit::RateLimitLayer};
use tower_http::trace::TraceLayer;
use tracing_subscriber::{EnvFilter, fmt, prelude::*};
use utopia_swagger_ui::SwaggerUi;

mod config; mod telemetry; mod routes; mod state; mod db;

#[derive(OpenApi)]
#[openapi(
    paths(routes::health::health, routes::items::list_items, routes::create_item),
    components(schemas(routes::items::Item, routes::items::NewItem)),
    tags((name = "items", description = "Item CRUD"))
)]
struct ApiDoc;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();

    //logging plus optional OpenTelemetry Bridge
    let filter = EnvFilter::try_from_default_env()
.unwrap_or_else(|_| EnvFilter::new("info"));
let fmt_layer = fmt::layer().with_target(false);
tracing_subscriber::registry().with(fmt_layer).init();

let pool = db::init_pool().await?;
let app_state = state::AppState { pool };

// Prometheus metrics layer
let (prom_layer, metric_handle) = PrometheusMetricLayer::pair();

let api = Router::new()
    .merge(routes::health::router())
    .merge(routes::items::router())
    .route("/metrics", get(|| async move { metric_handle.render() }));
let rate_per_sec: u64 = std::env::var("APP_RATE_LIMIT_PER_SECOND").ok()
    .and_then(|v| v.parse().ok()).unwrap_or(50);

let middleware = ServiceBuilder::new()
    .layer(TraceLayer::new_for_http())
    .layer(RateLimitLayer::new(rate_per_sec, std::Duration::from_secs(1)))
    .layer(prom_layer);

let app = Router::new()
    .merge(api)
    .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
    .with_state(app_state)
    .layer(middleware);

let host = std::env::var("APP_HOST").unwrap_or("0.0.0.0".into());
let port = u16 = std::env::var("APP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(8080);
let addr: SocketAddr = format!("{}:{}", host, port).parse()?;

tracing::info!(%addr, "listening");
axum::Server::bind(&addr).serve(app.into_make_service()).await?;
Ok(())
}