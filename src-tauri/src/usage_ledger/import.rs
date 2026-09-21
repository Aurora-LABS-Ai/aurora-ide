//! Incremental, retryable import from retained transcripts, without retention GC.

use super::{insert_event, Event, UsageLedger};
use anyhow::{Context, Result};
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

struct Source {
    log: PathBuf,
    meta: PathBuf,
    thread: String,
    surface: &'static str,
}

fn entries(path: &Path) -> Result<Vec<fs::DirEntry>> {
    match fs::read_dir(path) {
        Ok(items) => items
            .collect::<std::io::Result<Vec<_>>>()
            .map_err(Into::into),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(e) => Err(e).with_context(|| format!("read usage sources in {}", path.display())),
    }
}

fn folder_sources(root: &Path, surface: &'static str, out: &mut Vec<Source>) -> Result<()> {
    for entry in entries(root)? {
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let dir = entry.path();
        if dir.join("conversation.jsonl").is_file() {
            out.push(Source {
                log: dir.join("conversation.jsonl"),
                meta: dir.join("meta.json"),
                thread: entry.file_name().to_string_lossy().into_owned(),
                surface,
            });
        }
    }
    Ok(())
}

fn stamp(path: &Path) -> Result<String> {
    match fs::metadata(path) {
        Ok(meta) => Ok(format!(
            "{}:{}",
            meta.len(),
            meta.modified()?
                .duration_since(std::time::UNIX_EPOCH)?
                .as_nanos()
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("missing".into()),
        Err(e) => Err(e).with_context(|| format!("stat {}", path.display())),
    }
}

impl UsageLedger {
    /// Capture one transcript before deletion, retention cleanup, or a runtime
    /// rewrite can remove its history during the initial background import.
    pub fn preserve_source(
        &self,
        log: PathBuf,
        meta: PathBuf,
        thread: &str,
        surface: &'static str,
    ) -> Result<()> {
        let _guard = self
            .import_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("usage import lock poisoned"))?;
        let source = Source {
            log,
            meta,
            thread: thread.to_owned(),
            surface,
        };
        self.import_file(&source)?;
        if source.log.exists() {
            let fingerprint = format!("{}|{}", stamp(&source.log)?, stamp(&source.meta)?);
            let saved: Option<String> = self
                .connection()?
                .query_row(
                    "SELECT fingerprint FROM usage_imports WHERE source_path=?1",
                    [source.log.to_string_lossy().as_ref()],
                    |r| r.get(0),
                )
                .optional()?;
            anyhow::ensure!(
                saved.as_deref() == Some(&fingerprint),
                "conversation changed while preserving usage; retry the operation"
            );
        }
        self.flush()
    }

    pub fn reconcile(&self) -> Result<()> {
        let _guard = self
            .import_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("usage import lock poisoned"))?;
        let mut sources = Vec::new();
        for entry in entries(&self.root.join("sessions"))? {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type()?.is_file()
                && name.ends_with(".jsonl")
                && !name.ends_with(".rich.jsonl")
            {
                let thread = name.trim_end_matches(".jsonl").to_owned();
                sources.push(Source {
                    meta: path.with_file_name(format!("{thread}.meta.json")),
                    log: path,
                    thread,
                    surface: "build",
                });
            }
        }
        for project in entries(&self.root.join("projects"))? {
            if project.file_type()?.is_dir() {
                folder_sources(&project.path(), "build", &mut sources)?;
            }
        }
        folder_sources(&self.root.join("Chats"), "chat", &mut sources)?;
        sources.sort_by(|a, b| a.log.cmp(&b.log));
        for source in sources {
            self.import_file(&source)
                .with_context(|| format!("import usage from {}", source.log.display()))?;
        }
        Ok(())
    }

    fn import_file(&self, source: &Source) -> Result<()> {
        let fingerprint = format!("{}|{}", stamp(&source.log)?, stamp(&source.meta)?);
        let path = source.log.to_string_lossy();
        let known: Option<String> = self
            .connection()?
            .query_row(
                "SELECT fingerprint FROM usage_imports WHERE source_path=?1",
                [path.as_ref()],
                |r| r.get(0),
            )
            .optional()?;
        if known.as_deref() == Some(&fingerprint) {
            return Ok(());
        }

        let file = match fs::File::open(&source.log) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
        };
        let mut events = Vec::new();
        let mut occurrences = HashMap::<String, usize>::new();
        let mut totals = [0u64; 4];
        for (line_number, line) in BufReader::new(file).lines().enumerate() {
            let line = line?;
            if line.trim().is_empty() {
                continue;
            }
            let value: serde_json::Value = match serde_json::from_str(&line) {
                Ok(value) => value,
                Err(e) => {
                    // An actively appended line is retried, never checkpointed.
                    if format!("{}|{}", stamp(&source.log)?, stamp(&source.meta)?) != fingerprint {
                        return Ok(());
                    }
                    return Err(e)
                        .with_context(|| format!("invalid JSON on line {}", line_number + 1));
                }
            };
            let mut event = Event::from_value(&source.thread, &value, 0)
                .with_context(|| format!("invalid usage on line {}", line_number + 1))?;
            if value["event_id"].as_str().is_none() {
                let occurrence = occurrences.entry(event.id.clone()).or_default();
                if *occurrence > 0 {
                    event = Event::from_value(&source.thread, &value, *occurrence)?;
                }
                *occurrence += 1;
            }
            if let Some(u) = &event.usage {
                totals[0] += 1;
                totals[1] += u64::from(u.input_tokens)
                    + u64::from(u.cache_creation_input_tokens.unwrap_or(0));
                totals[2] += u64::from(u.output_tokens);
                totals[3] += u64::from(u.cache_read_input_tokens.unwrap_or(0));
            }
            events.push(event);
        }
        let meta: serde_json::Value = match fs::read(&source.meta) {
            Ok(bytes) => serde_json::from_slice(&bytes).context("invalid conversation metadata")?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => serde_json::Value::Null,
            Err(e) => return Err(e.into()),
        };
        // Take a stable snapshot before marking a file reconciled. A changed
        // source is retried next time, leaving already-recorded live events intact.
        if format!("{}|{}", stamp(&source.log)?, stamp(&source.meta)?) != fingerprint {
            return Ok(());
        }
        let mut conn = self.connection()?;
        let tx = conn.transaction()?;
        for event in &events {
            insert_event(&tx, event)?;
        }
        tx.execute(
            "INSERT INTO usage_threads (thread_id,title,workspace_root,surface) VALUES (?1,?2,?3,?4)
             ON CONFLICT(thread_id) DO UPDATE SET title=excluded.title,
             workspace_root=excluded.workspace_root,surface=excluded.surface",
            params![source.thread,meta["title"].as_str().unwrap_or(""),meta["workspaceRoot"].as_str(),source.surface],
        )?;
        // Source totals are an audit trail, not additional usage to sum.
        tx.execute(
            "INSERT INTO usage_imports VALUES (?1,?2,?3,?4,?5,?6,?7)
             ON CONFLICT(source_path) DO UPDATE SET fingerprint=excluded.fingerprint,
             message_count=excluded.message_count,usage_count=excluded.usage_count,
             input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,
             cache_read_tokens=excluded.cache_read_tokens",
            params![
                path,
                fingerprint,
                i64::try_from(events.len())?,
                i64::try_from(totals[0])?,
                i64::try_from(totals[1])?,
                i64::try_from(totals[2])?,
                i64::try_from(totals[3])?
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
}
