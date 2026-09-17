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
                "agentExecutionMode" => {
                    settings.agent_execution_mode = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.agent_execution_mode.clone())
                }
                "teamEnabled" => {
                    settings.team_enabled =
                        serde_json::from_str(&setting.value).unwrap_or(settings.team_enabled)
                }
                "maxTeamSize" => {
                    settings.max_team_size =
                        serde_json::from_str(&setting.value).unwrap_or(settings.max_team_size)
                }
                "teamLeadModel" => {
                    settings.team_lead_model = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.team_lead_model.clone())
                }
                "teamMemberModel" => {
                    settings.team_member_model = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.team_member_model.clone())
                }
                "globalInstructions" => {
                    settings.global_instructions = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.global_instructions.clone())
                }
                "globalInstructionProfiles" => {
                    settings.global_instruction_profiles = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.global_instruction_profiles.clone())
                }
                "activeGlobalInstructionProfileId" => {
                    settings.active_global_instruction_profile_id =
                        serde_json::from_str(&setting.value)
                            .unwrap_or(settings.active_global_instruction_profile_id.clone())
                }
                "compactionThresholdPct" => {
                    settings.compaction_threshold_pct = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.compaction_threshold_pct)
                }
                "compactionSummaryBudget" => {
                    settings.compaction_summary_budget = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.compaction_summary_budget)
                }
                "compactionModel" => {
                    settings.compaction_model = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.compaction_model.clone())
                }
                "titleMakerEnabled" => {
                    settings.title_maker_enabled =
                        serde_json::from_str(&setting.value).unwrap_or(settings.title_maker_enabled)
                }
                "titleMakerMode" => {
                    settings.title_maker_mode = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.title_maker_mode.clone())
                }
                "titleMakerBaseUrl" => {
                    settings.title_maker_base_url = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.title_maker_base_url.clone())
                }
                "titleMakerApiKey" => {
                    settings.title_maker_api_key = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.title_maker_api_key.clone())
                }
                "titleMakerModel" => {
                    settings.title_maker_model = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.title_maker_model.clone())
                }
                "workspaceAccess" => {
                    settings.workspace_access = serde_json::from_str(&setting.value)
                        .unwrap_or_else(|_| settings.workspace_access.clone())
                }
                "allowOutsideWorkspace" => {
                    settings.allow_outside_workspace = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.allow_outside_workspace)
                }
                "transcriptChapters" => {
                    settings.transcript_chapters =
                        serde_json::from_str(&setting.value).unwrap_or(settings.transcript_chapters)
                }
                "notifyOnTurnComplete" => {
                    settings.notify_on_turn_complete = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.notify_on_turn_complete)
                }
                "showActivityInTitle" => {
                    settings.show_activity_in_title = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.show_activity_in_title)
                }
                "browserTools" => {
                    settings.browser_tools =
                        serde_json::from_str(&setting.value).unwrap_or(settings.browser_tools)
                }
                "deferTools" => {
                    settings.defer_tools =
                        serde_json::from_str(&setting.value).unwrap_or(settings.defer_tools)
                }
                "mcpBridgeEnabled" => {
                    settings.mcp_bridge_enabled =
                        serde_json::from_str(&setting.value).unwrap_or(settings.mcp_bridge_enabled)
                }
                "autoApproveTools" => {
                    settings.auto_approve_tools =
                        serde_json::from_str(&setting.value).unwrap_or(settings.auto_approve_tools)
                }
                "autoAcceptChanges" => {
                    settings.auto_accept_changes =
                        serde_json::from_str(&setting.value).unwrap_or(settings.auto_accept_changes)
                }
                "explorerIconPack" => {
                    settings.explorer_icon_pack = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.explorer_icon_pack.clone())
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
                // Aurora Chat. Absent from this match until 2026-09-04, which
                // is why an image provider's key and models vanished on every
                // relaunch — the value was written by the frontend, dropped
                // here, and read back as the default.
                "auroraSurface" => {
                    settings.aurora_surface = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.aurora_surface.clone())
                }
                "chatModelShortlist" => {
                    settings.chat_model_shortlist = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.chat_model_shortlist.clone())
                }
                "deepResearchNext" => {
                    settings.deep_research_next = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.deep_research_next)
                }
                "imageProviders" => {
                    settings.image_providers = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.image_providers.clone())
                }
                "seededImageProviderIds" => {
                    settings.seeded_image_provider_ids = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.seeded_image_provider_ids.clone())
                }
                // Absent until 2026-09-16, and the same story one field over:
                // a category made in the providers rail, and every provider
                // moved into it, was gone on the next launch.
                "providerCategories" => {
                    settings.provider_categories = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.provider_categories.clone())
                }
                "fireworksTabEnabled" => {
                    settings.fireworks_tab_enabled = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.fireworks_tab_enabled)
                }
                "fireworksAccountId" => {
                    settings.fireworks_account_id = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.fireworks_account_id.clone())
                }
                "removedProviderIds" => {
                    settings.removed_provider_ids = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.removed_provider_ids.clone())
                }
                "speechEnabled" => {
                    settings.speech_enabled =
                        serde_json::from_str(&setting.value).unwrap_or(settings.speech_enabled)
                }
                "speechEngine" => {
                    settings.speech_engine = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.speech_engine.clone())
                }
                "speechRuntimePath" => {
                    settings.speech_runtime_path = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.speech_runtime_path.clone())
                }
                "speechModelPath" => {
                    settings.speech_model_path = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.speech_model_path.clone())
                }
                "speechBackend" => {
                    settings.speech_backend = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.speech_backend.clone())
                }
                "speechDevicePreference" => {
                    settings.speech_device_preference = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.speech_device_preference.clone())
                }
                "speechThreads" => {
                    settings.speech_threads =
                        serde_json::from_str(&setting.value).unwrap_or(settings.speech_threads)
                }
                "speechLanguage" => {
                    settings.speech_language = serde_json::from_str(&setting.value)
                        .unwrap_or(settings.speech_language.clone())
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
            "agentExecutionMode",
            &serde_json::to_string(&settings.agent_execution_mode).unwrap_or_default(),
        )?;
        self.set_setting(
            "teamEnabled",
            &serde_json::to_string(&settings.team_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "maxTeamSize",
            &serde_json::to_string(&settings.max_team_size).unwrap_or_default(),
        )?;
        self.set_setting(
            "teamLeadModel",
            &serde_json::to_string(&settings.team_lead_model).unwrap_or_default(),
        )?;
        self.set_setting(
            "teamMemberModel",
            &serde_json::to_string(&settings.team_member_model).unwrap_or_default(),
        )?;
        self.set_setting(
            "globalInstructions",
            &serde_json::to_string(&settings.global_instructions).unwrap_or_default(),
        )?;
        self.set_setting(
            "globalInstructionProfiles",
            &serde_json::to_string(&settings.global_instruction_profiles).unwrap_or_default(),
        )?;
        self.set_setting(
            "activeGlobalInstructionProfileId",
            &serde_json::to_string(&settings.active_global_instruction_profile_id)
                .unwrap_or_default(),
        )?;
        self.set_setting(
            "compactionThresholdPct",
            &serde_json::to_string(&settings.compaction_threshold_pct).unwrap_or_default(),
        )?;
        self.set_setting(
            "compactionSummaryBudget",
            &serde_json::to_string(&settings.compaction_summary_budget).unwrap_or_default(),
        )?;
        self.set_setting(
            "compactionModel",
            &serde_json::to_string(&settings.compaction_model).unwrap_or_default(),
        )?;
        self.set_setting(
            "titleMakerEnabled",
            &serde_json::to_string(&settings.title_maker_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "titleMakerMode",
            &serde_json::to_string(&settings.title_maker_mode).unwrap_or_default(),
        )?;
        self.set_setting(
            "titleMakerBaseUrl",
            &serde_json::to_string(&settings.title_maker_base_url).unwrap_or_default(),
        )?;
        self.set_setting(
            "titleMakerApiKey",
            &serde_json::to_string(&settings.title_maker_api_key).unwrap_or_default(),
        )?;
        self.set_setting(
            "titleMakerModel",
            &serde_json::to_string(&settings.title_maker_model).unwrap_or_default(),
        )?;
        self.set_setting(
            "workspaceAccess",
            &serde_json::to_string(&settings.workspace_access).unwrap_or_default(),
        )?;
        // Still written so a downgrade, or any reader that predates
        // `workspaceAccess`, sees the nearest truthful boolean.
        self.set_setting(
            "allowOutsideWorkspace",
            &serde_json::to_string(&settings.allow_outside_workspace).unwrap_or_default(),
        )?;
        self.set_setting(
            "transcriptChapters",
            &serde_json::to_string(&settings.transcript_chapters).unwrap_or_default(),
        )?;
        self.set_setting(
            "notifyOnTurnComplete",
            &serde_json::to_string(&settings.notify_on_turn_complete).unwrap_or_default(),
        )?;
        self.set_setting(
            "showActivityInTitle",
            &serde_json::to_string(&settings.show_activity_in_title).unwrap_or_default(),
        )?;
        self.set_setting(
            "browserTools",
            &serde_json::to_string(&settings.browser_tools).unwrap_or_default(),
        )?;
        self.set_setting(
            "deferTools",
            &serde_json::to_string(&settings.defer_tools).unwrap_or_default(),
        )?;
        self.set_setting(
            "mcpBridgeEnabled",
            &serde_json::to_string(&settings.mcp_bridge_enabled).unwrap_or_default(),
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
            "explorerIconPack",
            &serde_json::to_string(&settings.explorer_icon_pack).unwrap_or_default(),
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
        // Aurora Chat — see the matching arms in `get_app_settings`.
        self.set_setting(
            "auroraSurface",
            &serde_json::to_string(&settings.aurora_surface).unwrap_or_default(),
        )?;
        self.set_setting(
            "chatModelShortlist",
            &serde_json::to_string(&settings.chat_model_shortlist).unwrap_or_default(),
        )?;
        self.set_setting(
            "deepResearchNext",
            &serde_json::to_string(&settings.deep_research_next).unwrap_or_default(),
        )?;
        self.set_setting(
            "imageProviders",
            &serde_json::to_string(&settings.image_providers).unwrap_or_default(),
        )?;
        self.set_setting(
            "seededImageProviderIds",
            &serde_json::to_string(&settings.seeded_image_provider_ids).unwrap_or_default(),
        )?;
        self.set_setting(
            "providerCategories",
            &serde_json::to_string(&settings.provider_categories).unwrap_or_default(),
        )?;
        self.set_setting(
            "fireworksTabEnabled",
            &serde_json::to_string(&settings.fireworks_tab_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "fireworksAccountId",
            &serde_json::to_string(&settings.fireworks_account_id).unwrap_or_default(),
        )?;
        self.set_setting(
            "removedProviderIds",
            &serde_json::to_string(&settings.removed_provider_ids).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechEnabled",
            &serde_json::to_string(&settings.speech_enabled).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechEngine",
            &serde_json::to_string(&settings.speech_engine).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechRuntimePath",
            &serde_json::to_string(&settings.speech_runtime_path).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechModelPath",
            &serde_json::to_string(&settings.speech_model_path).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechBackend",
            &serde_json::to_string(&settings.speech_backend).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechDevicePreference",
            &serde_json::to_string(&settings.speech_device_preference).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechThreads",
            &serde_json::to_string(&settings.speech_threads).unwrap_or_default(),
        )?;
        self.set_setting(
            "speechLanguage",
            &serde_json::to_string(&settings.speech_language).unwrap_or_default(),
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
                    supports_tool_stream, enabled, is_custom,
                    custom_headers, custom_params, provider_type, default_temperature,
                    default_max_tokens, requires_api_key, sort_order, created_at, updated_at, api_keys,
                    description
             FROM llm_providers
             ORDER BY sort_order ASC",
        )?;

        let providers = stmt.query_map([], |row| {
            let custom_headers: Option<String> = row.get(11)?;
            let custom_params: Option<String> = row.get(12)?;
            let api_keys: Option<String> = row.get(20)?;

            Ok(LLMProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                nickname: row.get(2)?,
                description: row.get(21)?,
                base_url: row.get(3)?,
                api_key: row.get(4)?,
                model: row.get(5)?,
                context_window: row.get(6)?,
                max_output_tokens: row.get(7)?,
                supports_tool_stream: row.get::<_, i32>(8)? != 0,
                enabled: row.get::<_, i32>(9)? != 0,
                is_custom: row.get::<_, i32>(10)? != 0,
                custom_headers: custom_headers.and_then(|s| serde_json::from_str(&s).ok()),
                custom_params: custom_params.and_then(|s| serde_json::from_str(&s).ok()),
                api_keys: api_keys.and_then(|s| serde_json::from_str(&s).ok()),
                provider_type: row.get(13)?,
                default_temperature: row.get(14)?,
                default_max_tokens: row.get(15)?,
                requires_api_key: row.get::<_, i32>(16)? != 0,
                sort_order: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
                _legacy_supports_thinking: None,
                _legacy_supports_vision: None,
                _legacy_custom_models: None,
                _legacy_model_aliases: None,
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
                    supports_tool_stream, enabled, is_custom,
                    custom_headers, custom_params, provider_type, default_temperature,
                    default_max_tokens, requires_api_key, sort_order, created_at, updated_at, api_keys,
                    description
             FROM llm_providers
             WHERE id = ?1",
        )?;

        let result = stmt.query_row(params![id], |row| {
            let custom_headers: Option<String> = row.get(11)?;
            let custom_params: Option<String> = row.get(12)?;
            let api_keys: Option<String> = row.get(20)?;

            Ok(LLMProvider {
                id: row.get(0)?,
                name: row.get(1)?,
                nickname: row.get(2)?,
                description: row.get(21)?,
                base_url: row.get(3)?,
                api_key: row.get(4)?,
                model: row.get(5)?,
                context_window: row.get(6)?,
                max_output_tokens: row.get(7)?,
                supports_tool_stream: row.get::<_, i32>(8)? != 0,
                enabled: row.get::<_, i32>(9)? != 0,
                is_custom: row.get::<_, i32>(10)? != 0,
                custom_headers: custom_headers.and_then(|s| serde_json::from_str(&s).ok()),
                custom_params: custom_params.and_then(|s| serde_json::from_str(&s).ok()),
                api_keys: api_keys.and_then(|s| serde_json::from_str(&s).ok()),
                provider_type: row.get(13)?,
                default_temperature: row.get(14)?,
                default_max_tokens: row.get(15)?,
                requires_api_key: row.get::<_, i32>(16)? != 0,
                sort_order: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
                _legacy_supports_thinking: None,
                _legacy_supports_vision: None,
                _legacy_custom_models: None,
                _legacy_model_aliases: None,
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
        let custom_headers = provider
            .custom_headers
            .as_ref()
            .map(|h| serde_json::to_string(h).unwrap_or_default());
        let custom_params = provider
            .custom_params
            .as_ref()
            .map(|p| serde_json::to_string(p).unwrap_or_default());
        // Persist the key pool as a JSON array string. `None` (and an empty
        // array) round-trips to SQL NULL so the single-key path is unchanged
        // for every provider that doesn't use pooling.
        let api_keys = provider
            .api_keys
            .as_ref()
            .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false))
            .map(|v| serde_json::to_string(v).unwrap_or_default());

        self.conn.execute(
            "INSERT INTO llm_providers (
                id, name, nickname, base_url, api_key, model, context_window, max_output_tokens,
                supports_tool_stream, enabled, is_custom, custom_headers, custom_params,
                provider_type, default_temperature, default_max_tokens, requires_api_key,
                sort_order, created_at, updated_at, api_keys, description
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
            ON CONFLICT(id) DO UPDATE SET
                name = ?2, nickname = ?3, base_url = ?4, api_key = ?5, model = ?6, context_window = ?7,
                max_output_tokens = ?8, supports_tool_stream = ?9, enabled = ?10, is_custom = ?11,
                custom_headers = ?12, custom_params = ?13, provider_type = ?14,
                default_temperature = ?15, default_max_tokens = ?16, requires_api_key = ?17,
                sort_order = ?18, updated_at = ?20, api_keys = ?21, description = ?22",
            params![
                provider.id,
                provider.name,
                provider.nickname,
                provider.base_url,
                provider.api_key,
                provider.model,
                provider.context_window,
                provider.max_output_tokens,
                provider.supports_tool_stream as i32,
                provider.enabled as i32,
                provider.is_custom as i32,
                custom_headers,
                custom_params,
                provider.provider_type,
                provider.default_temperature,
                provider.default_max_tokens,
                provider.requires_api_key as i32,
                provider.sort_order,
                if provider.created_at.is_empty() { &now } else { &provider.created_at },
                now,
                api_keys,
                provider.description,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::models::GlobalInstructionProfile;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().expect("in-memory db");
        crate::db::schema::initialize_schema(&conn).expect("schema");
        conn
    }

    /// The regression this pins: a field the frontend saved but the struct did
    /// not carry was silently dropped by serde on the way in and absent on the
    /// way out — `deferTools` reset to off on every launch, and browser tools,
    /// the turn-complete cues, and the compaction model lost their values
    /// invisibly (their frontend defaults masked it). Flip every once-dropped
    /// field away from its default, round-trip through the repository, and
    /// require the WHOLE value back unchanged.
    #[test]
    fn app_settings_survive_a_save_load_round_trip() {
        let conn = db();
        let repo = SettingsRepository::new(&conn);

        let mut settings = AppSettings::default();
        settings.defer_tools = true;
        settings.browser_tools = false;
        settings.notify_on_turn_complete = false;
        settings.show_activity_in_title = false;
        settings.compaction_model = "openai:gpt-5.2".into();
        settings.global_instructions = "active mirror".into();
        settings.global_instruction_profiles = vec![
            GlobalInstructionProfile {
                id: "one".into(),
                name: "Default".into(),
                text: "quiet rules".into(),
            },
            GlobalInstructionProfile {
                id: "two".into(),
                name: "Reviewer".into(),
                text: "active mirror".into(),
            },
        ];
        settings.active_global_instruction_profile_id = "two".into();
        // Aurora Chat. Every one of these was written by the frontend and
        // silently dropped here until 2026-09-04 — the whole-struct comparison
        // below is what pins them, so a field added to `AppSettings` without a
        // save/load arm fails this test rather than a person's settings.
        settings.aurora_surface = "chat".into();
        settings.chat_model_shortlist = vec!["p:alpha".into(), "p:beta".into()];
        settings.deep_research_next = true;
        settings.seeded_image_provider_ids = vec!["img-apikl".into()];
        settings.image_providers = serde_json::json!([{
            "id": "img-a6api",
            "name": "a6api",
            "baseUrl": "https://api.a6api.com/v1",
            "apiKey": "sk-live",
            "apiFormat": "a6api",
            "responseShape": "url",
            "enabled": true,
            "builtIn": true,
            "models": [{ "id": "img-a6api:gpt-image-1.5", "modelKey": "gpt-image-1.5" }],
        }]);

        repo.save_app_settings(&settings).expect("save");
        let loaded = repo.get_app_settings().expect("load");

        assert_eq!(
            serde_json::to_value(&settings).expect("serialize saved"),
            serde_json::to_value(&loaded).expect("serialize loaded"),
        );
    }

    /// Every field `AppSettings` declares must reach a row in `app_settings`.
    ///
    /// The round-trip test above says in its own comment that it pins this —
    /// "a field added to `AppSettings` without a save/load arm fails this test
    /// rather than a person's settings". **It does not**, and that is how the
    /// next field was lost anyway. It compares a struct that the test author
    /// moved away from its defaults against what came back; a field nobody
    /// remembered to touch is default going in and default coming out, so it
    /// matches whether or not it was ever written. A field missing from the
    /// struct entirely is invisible to it twice over.
    ///
    /// This one enumerates the struct instead of a person's memory: serialize
    /// the defaults, list what the save actually wrote, and name anything that
    /// did not make it. Nothing needs adding here when a field is added — the
    /// field arrives on its own, and stays failing until it has a
    /// `set_setting` call.
    ///
    /// Cost of not having it, twice: `imageProviders` (2026-09-04) took an API
    /// key and a model list with it on every relaunch, and
    /// `providerCategories` (2026-09-16) wiped every category in the providers
    /// rail, and every provider filed into one, on every launch.
    #[test]
    fn every_app_settings_field_reaches_a_row() {
        let conn = db();
        SettingsRepository::new(&conn)
            .save_app_settings(&AppSettings::default())
            .expect("save");

        let mut statement = conn.prepare("SELECT key FROM app_settings").expect("prepare");
        let stored: std::collections::HashSet<String> = statement
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query")
            .map(|key| key.expect("key"))
            .collect();

        let declared = serde_json::to_value(AppSettings::default()).expect("serialize");
        let missing: Vec<&String> = declared
            .as_object()
            .expect("settings serialize as an object")
            .keys()
            .filter(|key| !stored.contains(*key))
            .collect();

        assert!(
            missing.is_empty(),
            "these `AppSettings` fields are never written to the database, so they reset on \
             every launch: {missing:?}. Add a `set_setting` for each in `save_app_settings` and \
             a match arm in `get_app_settings`.",
        );
    }

    /// The symptom, stated on its own because it is the one a person met: type
    /// a key into an image provider, add a model, relaunch, and both were gone —
    /// so the model picker had no image models and its Image tab never appeared.
    #[test]
    fn an_image_provider_keeps_its_key_and_models_across_a_relaunch() {
        let conn = db();
        let repo = SettingsRepository::new(&conn);

        let mut settings = AppSettings::default();
        settings.image_providers = serde_json::json!([{
            "id": "img-a6api",
            "name": "a6api",
            "baseUrl": "https://api.a6api.com/v1",
            "apiKey": "sk-the-one-that-vanished",
            "apiFormat": "a6api",
            "responseShape": "url",
            "enabled": true,
            "models": [
                { "id": "img-a6api:gpt-image-1.5", "modelKey": "gpt-image-1.5", "canEdit": true },
                { "id": "img-a6api:nano-banana", "modelKey": "nano-banana" },
            ],
        }]);
        repo.save_app_settings(&settings).expect("save");

        let row = &repo.get_app_settings().expect("load").image_providers[0];
        assert_eq!(row["apiKey"], "sk-the-one-that-vanished");
        assert_eq!(row["models"].as_array().expect("models").len(), 2);
        assert_eq!(row["models"][0]["canEdit"], true);
    }

    /// A database from before the profile fields existed must still load, and
    /// the defaults must match what the frontend assumes: browser/notify/
    /// activity ON, defer OFF, no profiles, nothing active.
    #[test]
    fn a_row_without_the_new_keys_loads_the_agreed_defaults() {
        let conn = db();
        let repo = SettingsRepository::new(&conn);

        let loaded = repo.get_app_settings().expect("load empty table");
        assert!(loaded.browser_tools);
        assert!(loaded.notify_on_turn_complete);
        assert!(loaded.show_activity_in_title);
        assert!(!loaded.defer_tools);
        assert!(loaded.compaction_model.is_empty());
        assert!(loaded.global_instruction_profiles.is_empty());
        assert!(loaded.active_global_instruction_profile_id.is_empty());
    }
}
