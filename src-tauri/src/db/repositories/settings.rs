use crate::db::error::{DbError, DbResult};
use crate::db::models::{AppSetting, AppSettings, LLMProvider, ToolSetting};
use rusqlite::{params, Connection};

/// Repository for app settings operations
pub struct SettingsRepository<'a> {
    conn: &'a Connection,
}

impl<'a> SettingsRepository<'a> {
    pub fn new(conn: &'a Connection) -> Self {
        Self { conn }
    }

    // ============================================================
    // APP SETTINGS (Key-Value Store)
    // ============================================================

    /// Get a setting by key
    pub fn get_setting(&self, key: &str) -> DbResult<Option<AppSetting>> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value, updated_at FROM app_settings WHERE key = ?1")?;

        let result = stmt.query_row(params![key], |row| {
            Ok(AppSetting {
                key: row.get(0)?,
                value: row.get(1)?,
                updated_at: row.get(2)?,
            })
        });

        match result {
            Ok(setting) => Ok(Some(setting)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Set a setting value
    pub fn set_setting(&self, key: &str, value: &str) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();

        self.conn.execute(
            "INSERT INTO app_settings (key, value, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3",
            params![key, value, now],
        )?;

        Ok(())
    }

    /// Get all settings
    pub fn get_all_settings(&self) -> DbResult<Vec<AppSetting>> {
        let mut stmt = self
            .conn
            .prepare("SELECT key, value, updated_at FROM app_settings")?;

        let settings = stmt.query_map([], |row| {
            Ok(AppSetting {
                key: row.get(0)?,
                value: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?;

        let mut result = Vec::new();
        for setting in settings {
            result.push(setting?);
        }
        Ok(result)
    }

    /// Delete a setting
    #[allow(dead_code)]
    pub fn delete_setting(&self, key: &str) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        Ok(())
    }

    /// Get complete app settings (with defaults for missing values)
    pub fn get_app_settings(&self) -> DbResult<AppSettings> {
        let mut settings = AppSettings::default();

        for setting in self.get_all_settings()? {
            match setting.key.as_str() {
                "selectedModel" => {
                    settings.selected_model =
                        serde_json::from_str(&setting.value).unwrap_or(settings.selected_model)
                }
                "autoApproveTools" => {
                    settings.auto_approve_tools =
                        serde_json::from_str(&setting.value).unwrap_or(settings.auto_approve_tools)
                }
                "autoAcceptChanges" => {
                    settings.auto_accept_changes =
                        serde_json::from_str(&setting.value).unwrap_or(settings.auto_accept_changes)
                }
                "fontSize" => {
                    settings.font_size =
                        serde_json::from_str(&setting.value).unwrap_or(settings.font_size)
                }
                "wrapMode" => {
                    settings.wrap_mode =
                        serde_json::from_str(&setting.value).unwrap_or(settings.wrap_mode)
                }
                "theme" => {
                    settings.theme = serde_json::from_str(&setting.value).unwrap_or(settings.theme)
                }
                "thinkingEnabled" => {
                    settings.thinking_enabled =
                        serde_json::from_str(&setting.value).unwrap_or(settings.thinking_enabled)
                }
                "syntaxValidationEnabled" => {
                    settings.syntax_validation_enabled = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.syntax_validation_enabled)
                }
                "projectLayoutEnabled" => {
                    settings.project_layout_enabled = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.project_layout_enabled)
                }
                "uiFontFamily" => {
                    settings.ui_font_family = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.ui_font_family.clone())
                }
                "uiScale" => {
                    settings.ui_scale =
                        serde_json::from_str(&setting.value).unwrap_or(settings.ui_scale)
                }
                "uiTextScale" => {
                    settings.ui_text_scale =
                        serde_json::from_str(&setting.value).unwrap_or(settings.ui_text_scale)
                }
                "maxTokens" => {
                    settings.max_tokens =
                        serde_json::from_str(&setting.value).unwrap_or(settings.max_tokens)
                }
                "temperature" => {
                    settings.temperature =
                        serde_json::from_str(&setting.value).unwrap_or(settings.temperature)
                }
                "autoSave" => {
                    settings.auto_save =
                        serde_json::from_str(&setting.value).unwrap_or(settings.auto_save)
                }
                "autoSaveDelay" => {
                    settings.auto_save_delay =
                        serde_json::from_str(&setting.value).unwrap_or(settings.auto_save_delay)
                }
                "maxToolCallsPerRequest" => {
                    settings.max_tool_calls_per_request = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.max_tool_calls_per_request)
                }
                "skillsEnabled" => {
                    settings.skills_enabled =
                        serde_json::from_str(&setting.value).unwrap_or(settings.skills_enabled)
                }
                "skillToggles" => {
                    settings.skill_toggles = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.skill_toggles.clone())
                }
                "fireworksTabEnabled" => {
                    settings.fireworks_tab_enabled = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.fireworks_tab_enabled)
                }
                "fireworksAccountId" => {
                    settings.fireworks_account_id = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.fireworks_account_id.clone())
                }
                _ => {}
            }
        }

        Ok(settings)
    }

    /// Save complete app settings
    pub fn save_app_settings(&self, settings: &AppSettings) -> DbResult<()> {
        self.set_setting(
            "selectedModel",
            &serde_json::to_string(&settings.selected_model).unwrap_or_default(),
        )?;
        self.set_setting(
            "autoApproveTools",
            &serde_json::to_string(&settings.auto_approve_tools).unwrap_or_default(),
        )?;
        self.set_setting(
            "autoAcceptChanges",
            &serde_json::to_string(&settings.auto_accept_changes).unwrap_or_default(),
        )?;
        self.set_setting(
            "fontSize",
            &serde_json::to_string(&settings.font_size).unwrap_or_default(),
        )?;
        self.set_setting(
            "wrapMode",
            &serde_json::to_string(&settings.wrap_mode).unwrap_or_default(),
        )?;
        self.set_setting(
            "theme",
            &serde_json::to_string(&settings.theme).unwrap_or_default(),
        )?;
        self.set_setting(
            "thinkingEnabled",
            &serde_json::to_string(&settings.thinking_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "syntaxValidationEnabled",
            &serde_json::to_string(&settings.syntax_validation_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "projectLayoutEnabled",
            &serde_json::to_string(&settings.project_layout_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "uiFontFamily",
            &serde_json::to_string(&settings.ui_font_family).unwrap_or_default(),
        )?;
        self.set_setting(
            "uiScale",
            &serde_json::to_string(&settings.ui_scale).unwrap_or_default(),
        )?;
        self.set_setting(
            "uiTextScale",
            &serde_json::to_string(&settings.ui_text_scale).unwrap_or_default(),
        )?;
        self.set_setting(
            "maxTokens",
            &serde_json::to_string(&settings.max_tokens).unwrap_or_default(),
        )?;
        self.set_setting(
            "temperature",
            &serde_json::to_string(&settings.temperature).unwrap_or_default(),
        )?;
        self.set_setting(
            "autoSave",
            &serde_json::to_string(&settings.auto_save).unwrap_or_default(),
        )?;
        self.set_setting(
            "autoSaveDelay",
            &serde_json::to_string(&settings.auto_save_delay).unwrap_or_default(),
        )?;
        self.set_setting(
            "maxToolCallsPerRequest",
            &serde_json::to_string(&settings.max_tool_calls_per_request).unwrap_or_default(),
        )?;
        self.set_setting(
            "skillsEnabled",
            &serde_json::to_string(&settings.skills_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "skillToggles",
            &serde_json::to_string(&settings.skill_toggles).unwrap_or_default(),
        )?;
        self.set_setting(
            "fireworksTabEnabled",
            &serde_json::to_string(&settings.fireworks_tab_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "fireworksAccountId",
            &serde_json::to_string(&settings.fireworks_account_id).unwrap_or_default(),
        )?;
        Ok(())
    }

    // ============================================================
    // LLM PROVIDERS
    // ============================================================

    /// Get all LLM providers
    pub fn get_all_providers(&self) -> DbResult<Vec<LLMProvider>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, nickname, base_url, api_key, model, context_window, max_output_tokens,
                    supports_thinking, supports_tool_stream, enabled, is_custom, custom_models,
                    model_aliases, custom_headers, custom_params, provider_type, default_temperature,
                    default_max_tokens, requires_api_key, sort_order, created_at, updated_at
             FROM llm_providers
             ORDER BY sort_order ASC"
        )?;

        let providers = stmt.query_map([], |row| {
            let custom_models: Option<String> = row.get(12)?;
            let model_aliases: Option<String> = row.get(13)?;
            let custom_headers: Option<String> = row.get(14)?;
            let custom_params: Option<String> = row.get(15)?;

            Ok(LLMProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                nickname: row.get(2)?,
                base_url: row.get(3)?,
                api_key: row.get(4)?,
                model: row.get(5)?,
                context_window: row.get(6)?,
                max_output_tokens: row.get(7)?,
                supports_thinking: row.get::<_, i32>(8)? != 0,
                supports_tool_stream: row.get::<_, i32>(9)? != 0,
                enabled: row.get::<_, i32>(10)? != 0,
                is_custom: row.get::<_, i32>(11)? != 0,
                custom_models: custom_models.and_then(|s| serde_json::from_str(&s).ok()),
                model_aliases: model_aliases.and_then(|s| serde_json::from_str(&s).ok()),
                custom_headers: custom_headers.and_then(|s| serde_json::from_str(&s).ok()),
                custom_params: custom_params.and_then(|s| serde_json::from_str(&s).ok()),
                provider_type: row.get(16)?,
                default_temperature: row.get(17)?,
                default_max_tokens: row.get(18)?,
                requires_api_key: row.get::<_, i32>(19)? != 0,
                sort_order: row.get(20)?,
                created_at: row.get(21)?,
                updated_at: row.get(22)?,
            })
        })?;

        let mut result = Vec::new();
        for provider in providers {
            result.push(provider?);
        }
        Ok(result)
    }

    /// Get a provider by ID
    pub fn get_provider(&self, id: &str) -> DbResult<Option<LLMProvider>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, name, nickname, base_url, api_key, model, context_window, max_output_tokens,
                    supports_thinking, supports_tool_stream, enabled, is_custom, custom_models,
                    model_aliases, custom_headers, custom_params, provider_type, default_temperature,
                    default_max_tokens, requires_api_key, sort_order, created_at, updated_at
             FROM llm_providers
             WHERE id = ?1"
        )?;

        let result = stmt.query_row(params![id], |row| {
            let custom_models: Option<String> = row.get(12)?;
            let model_aliases: Option<String> = row.get(13)?;
            let custom_headers: Option<String> = row.get(14)?;
            let custom_params: Option<String> = row.get(15)?;

            Ok(LLMProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                nickname: row.get(2)?,
                base_url: row.get(3)?,
                api_key: row.get(4)?,
                model: row.get(5)?,
                context_window: row.get(6)?,
                max_output_tokens: row.get(7)?,
                supports_thinking: row.get::<_, i32>(8)? != 0,
                supports_tool_stream: row.get::<_, i32>(9)? != 0,
                enabled: row.get::<_, i32>(10)? != 0,
                is_custom: row.get::<_, i32>(11)? != 0,
                custom_models: custom_models.and_then(|s| serde_json::from_str(&s).ok()),
                model_aliases: model_aliases.and_then(|s| serde_json::from_str(&s).ok()),
                custom_headers: custom_headers.and_then(|s| serde_json::from_str(&s).ok()),
                custom_params: custom_params.and_then(|s| serde_json::from_str(&s).ok()),
                provider_type: row.get(16)?,
                default_temperature: row.get(17)?,
                default_max_tokens: row.get(18)?,
                requires_api_key: row.get::<_, i32>(19)? != 0,
                sort_order: row.get(20)?,
                created_at: row.get(21)?,
                updated_at: row.get(22)?,
            })
        });

        match result {
            Ok(provider) => Ok(Some(provider)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Save or update a provider
    pub fn save_provider(&self, provider: &LLMProvider) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let custom_models = provider
            .custom_models
            .as_ref()
            .map(|m| serde_json::to_string(m).unwrap_or_default());
        let model_aliases = provider
            .model_aliases
            .as_ref()
            .map(|m| serde_json::to_string(m).unwrap_or_default());
        let custom_headers = provider
            .custom_headers
            .as_ref()
            .map(|h| serde_json::to_string(h).unwrap_or_default());
        let custom_params = provider
            .custom_params
            .as_ref()
            .map(|p| serde_json::to_string(p).unwrap_or_default());

        self.conn.execute(
            "INSERT INTO llm_providers (
                id, name, nickname, base_url, api_key, model, context_window, max_output_tokens,
                supports_thinking, supports_tool_stream, enabled, is_custom, custom_models,
                model_aliases, custom_headers, custom_params, provider_type, default_temperature,
                default_max_tokens, requires_api_key, sort_order, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
            ON CONFLICT(id) DO UPDATE SET
                name = ?2, nickname = ?3, base_url = ?4, api_key = ?5, model = ?6, context_window = ?7,
                max_output_tokens = ?8, supports_thinking = ?9, supports_tool_stream = ?10,
                enabled = ?11, is_custom = ?12, custom_models = ?13, model_aliases = ?14, custom_headers = ?15,
                custom_params = ?16, provider_type = ?17, default_temperature = ?18,
                default_max_tokens = ?19, requires_api_key = ?20, sort_order = ?21, updated_at = ?23",
            params![
                provider.id,
                provider.name,
                provider.nickname,
                provider.base_url,
                provider.api_key,
                provider.model,
                provider.context_window,
                provider.max_output_tokens,
                provider.supports_thinking as i32,
                provider.supports_tool_stream as i32,
                provider.enabled as i32,
                provider.is_custom as i32,
                custom_models,
                model_aliases,
                custom_headers,
                custom_params,
                provider.provider_type,
                provider.default_temperature,
                provider.default_max_tokens,
                provider.requires_api_key as i32,
                provider.sort_order,
                if provider.created_at.is_empty() { &now } else { &provider.created_at },
                now,
            ],
        )?;

        Ok(())
    }

    /// Delete a provider
    pub fn delete_provider(&self, id: &str) -> DbResult<()> {
        self.conn
            .execute("DELETE FROM llm_providers WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// Check if providers table is empty
    pub fn has_providers(&self) -> DbResult<bool> {
        let count: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM llm_providers", [], |row| row.get(0))?;
        Ok(count > 0)
    }

    // ============================================================
    // TOOL SETTINGS
    // ============================================================

    /// Get all tool settings
    pub fn get_all_tool_settings(&self) -> DbResult<Vec<ToolSetting>> {
        let mut stmt = self
            .conn
            .prepare("SELECT tool_name, approval_mode, updated_at FROM tool_settings")?;

        let settings = stmt.query_map([], |row| {
            Ok(ToolSetting {
                tool_name: row.get(0)?,
                approval_mode: row.get(1)?,
                updated_at: row.get(2)?,
            })
        })?;

        let mut result = Vec::new();
        for setting in settings {
            result.push(setting?);
        }
        Ok(result)
    }

    /// Get a tool setting by name
    #[allow(dead_code)]
    pub fn get_tool_setting(&self, tool_name: &str) -> DbResult<Option<ToolSetting>> {
        let mut stmt = self.conn.prepare(
            "SELECT tool_name, approval_mode, updated_at FROM tool_settings WHERE tool_name = ?1",
        )?;

        let result = stmt.query_row(params![tool_name], |row| {
            Ok(ToolSetting {
                tool_name: row.get(0)?,
                approval_mode: row.get(1)?,
                updated_at: row.get(2)?,
            })
        });

        match result {
            Ok(setting) => Ok(Some(setting)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(DbError::Sqlite(e)),
        }
    }

    /// Set tool approval mode
    pub fn set_tool_setting(&self, tool_name: &str, approval_mode: &str) -> DbResult<()> {
        let now = chrono::Utc::now().to_rfc3339();

        self.conn.execute(
            "INSERT INTO tool_settings (tool_name, approval_mode, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(tool_name) DO UPDATE SET approval_mode = ?2, updated_at = ?3",
            params![tool_name, approval_mode, now],
        )?;

        Ok(())
    }

    /// Save all tool settings at once
    pub fn save_all_tool_settings(&self, settings: &[(String, String)]) -> DbResult<()> {
        for (tool_name, approval_mode) in settings {
            self.set_tool_setting(tool_name, approval_mode)?;
        }
        Ok(())
    }
}
