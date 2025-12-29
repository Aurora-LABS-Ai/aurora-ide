use serde::Serialize;
use thiserror::Error;

/// Database error types
#[derive(Error, Debug, Serialize)]
pub enum DbError {
    #[error("SQLite error: {0}")]
    #[serde(serialize_with = "serialize_error")]
    Sqlite(#[from] rusqlite::Error),

    #[error("Serialization error: {0}")]
    #[serde(serialize_with = "serialize_error")]
    Serialization(#[from] serde_json::Error),

    #[error("IO error: {0}")]
    #[serde(serialize_with = "serialize_error")]
    Io(#[from] std::io::Error),

    #[error("Migration error: {0}")]
    Migration(String),

    #[error("Record not found: {0}")]
    #[allow(dead_code)]
    NotFound(String),

    #[error("Invalid data: {0}")]
    #[allow(dead_code)]
    InvalidData(String),
}

/// Result type for database operations
pub type DbResult<T> = Result<T, DbError>;

fn serialize_error<E: std::fmt::Display, S: serde::Serializer>(
    err: &E,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&err.to_string())
}
