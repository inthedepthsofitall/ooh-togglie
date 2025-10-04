# ooh-togglie
A flag request checker processing apis using prometheus
Prereqs: Rust, Docker, Docker Compose.

Copy env: cp .env.example .env (edit if needed)

Start infra: docker compose up -d (Postgres, Redis, Jaeger, Prometheus)

Run app: cargo run

Hit endpoints:

Health: GET http://localhost:8080/health

Swagger UI: http://localhost:8080/docs

Metrics: http://localhost:8080/metrics


Stack

Runtime: Rust (1.76+)

Web: Axum + Tower

DB: PostgreSQL (SQLx)

Cache/Rate: Redis (for tokens/counters, optional at MVP)

Docs: OpenAPI (utoipa) + Swagger UI

Rate Limiting: tower-governor (token bucket)

Metrics: Prometheus (/metrics) via axum-prometheus

Tracing: tracing + OpenTelemetry (OTLP) with Jaeger/Tempo compatible

Config: dotenvy + env vars

Features (MVP)

/health — liveness/readiness

/metrics — Prometheus metrics

/docs — Swagger UI (OpenAPI)

/v1/items — tiny CRUD demo (Postgres via SQLx)

Global rate‑limit (configurable), with optional IP‑based policy

Structured logs and trace IDs across requests

Deploy: Docker, Docker Compose locally; OCI Always Free compute for prod

├── Cargo.toml
├── .env.example
├── docker-compose.yml
├── README.md
└── src/
├── main.rs
├── config.rs
├── routes/
│ ├── health.rs
│ ├── items.rs
│ └── docs.rs
├── telemetry.rs
├── state.rs
└── db.rs