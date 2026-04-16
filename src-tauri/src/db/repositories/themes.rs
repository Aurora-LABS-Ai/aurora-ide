use crate::db::error::DbResult;
use crate::db::models::CustomTheme;
use rusqlite::{params, Connection, OptionalExtension};

/// Theme repository with built-in duplicate prevention
pub struct ThemeRepository<'a> {
    conn: &'a Connection,
}

impl<'a> ThemeRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    /// Save a custom theme with duplicate prevention
    /// If a theme with the same name+author exists, it updates that theme
    /// Otherwise creates a new theme
    pub fn save(&self, theme: &CustomTheme) -> DbResult<()> {
        // First check if a theme with same name+author already exists
        let existing_id: Option<String> = self
            .conn
            .query_row(
                "SELECT id FROM custom_themes 
             WHERE LOWER(TRIM(name)) = LOWER(TRIM(?1)) 
             AND LOWER(TRIM(author)) = LOWER(TRIM(?2))",
                params![&theme.name, &theme.author],
                |row| row.get(0),
            )
            .optional()?;

        if let Some(existing_id) = existing_id {
            // Update existing theme (use existing ID to maintain references)
            self.conn.execute(
                "UPDATE custom_themes SET
                    name = ?1,
                    author = ?2,
                    version = ?3,
                    type = ?4,
                    colors = ?5,
                    token_colors = ?6,
                    updated_at = ?7
                 WHERE id = ?8",
                params![
                    theme.name,
                    theme.author,
                    theme.version,
                    theme.theme_type,
                    theme.colors,
                    theme.token_colors,
                    theme.updated_at,
                    existing_id
                ],
            )?;
        } else {
            // Insert new theme
            self.conn.execute(
                "INSERT INTO custom_themes (
                    id, name, author, version, type, colors, token_colors, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    theme.id,
                    theme.name,
                    theme.author,
                    theme.version,
                    theme.theme_type,
                    theme.colors,
                    theme.token_colors,
                    theme.created_at,
                    theme.updated_at
                ],
            )?;
        }
        Ok(())
    }

    /// Delete a custom theme by ID
    pub fn delete(&self, id: &str) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM custom_themes WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Delete all duplicate themes, keeping only the most recently updated one per name+author
    pub fn cleanup_duplicates(&self) -> DbResult<u32> {
        // Delete duplicates keeping the one with latest updated_at
        let deleted = self.conn.execute(
            "DELETE FROM custom_themes 
             WHERE id NOT IN (
                SELECT id FROM (
                    SELECT id, ROW_NUMBER() OVER (
                        PARTITION BY LOWER(TRIM(name)), LOWER(TRIM(author)) 
                        ORDER BY updated_at DESC
                    ) as rn
                    FROM custom_themes
                ) WHERE rn = 1
             )",
            [],
        )?;
        Ok(deleted as u32)
    }

    /// Get all custom themes (deduplicated)
    pub fn get_all(&self) -> DbResult<Vec<CustomTheme>> {
        // First cleanup any duplicates
        let _ = self.cleanup_duplicates();

        let mut stmt = self.conn.prepare(
            "SELECT id, name, author, version, type, colors, token_colors, created_at, updated_at
             FROM custom_themes
             ORDER BY updated_at DESC",
        )?;

        let theme_iter = stmt.query_map([], |row| {
            Ok(CustomTheme {
                id: row.get(0)?,
                name: row.get(1)?,
                author: row.get(2)?,
                version: row.get(3)?,
                theme_type: row.get(4)?,
                colors: row.get(5)?,
                token_colors: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })
        })?;

        let mut themes = Vec::new();
        for theme in theme_iter {
            themes.push(theme?);
        }

        Ok(themes)
    }

    /// Get a specific custom theme by ID
    #[allow(dead_code)]
    pub fn get(&self, id: &str) -> DbResult<Option<CustomTheme>> {
        self.conn.query_row(
            "SELECT id, name, author, version, type, colors, token_colors, created_at, updated_at
             FROM custom_themes
             WHERE id = ?1",
            params![id],
            |row| {
                Ok(CustomTheme {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    author: row.get(2)?,
                    version: row.get(3)?,
                    theme_type: row.get(4)?,
                    colors: row.get(5)?,
                    token_colors: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }

    /// Find theme by name and author (case insensitive)
    #[allow(dead_code)]
    pub fn find_by_name_author(&self, name: &str, author: &str) -> DbResult<Option<CustomTheme>> {
        self.conn.query_row(
            "SELECT id, name, author, version, type, colors, token_colors, created_at, updated_at
             FROM custom_themes
             WHERE LOWER(TRIM(name)) = LOWER(TRIM(?1))
             AND LOWER(TRIM(author)) = LOWER(TRIM(?2))",
            params![name, author],
            |row| {
                Ok(CustomTheme {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    author: row.get(2)?,
                    version: row.get(3)?,
                    theme_type: row.get(4)?,
                    colors: row.get(5)?,
                    token_colors: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
    }
}
