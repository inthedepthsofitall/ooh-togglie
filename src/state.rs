use crate::db::Db;
#[derive(Clone)]
pub struct AppState { pub pool: Db }