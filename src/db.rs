use sqlx::{Pool, Postgres};
pub type Db = Pool<Postgres>;

pub async fn init_pool() -> anyhow::Result<Db> {
    let db_url = std::env::var("DATABASE_URL").expect("DATABASE_URL not set");
    let pool = Pool::<Postgres>::connect(&db_url).await?;
    // Optionally run migratrions with sqlx::migrate!("./migrations").run(&pool).await?
    Ok(pool)
}