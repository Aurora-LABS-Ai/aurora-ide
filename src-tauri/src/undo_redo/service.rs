use std::collections::HashMap;
use std::fs;
use std::sync::Mutex;

use super::types::{FileChange, FileUndoState, UndoRedoError, UndoRedoResult};

/// Simple undo/redo stack implementation
/// More straightforward than the undo crate for our per-file use case
#[derive(Debug)]
struct UndoStack {
    /// Stack of previous states (for undo)
    undo_stack: Vec<String>,
    /// Stack of undone states (for redo)
    redo_stack: Vec<String>,
    /// Maximum history size
    max_size: usize,
}

impl UndoStack {
    fn new(max_size: usize) -> Self {
        Self {
            undo_stack: Vec::new(),
            redo_stack: Vec::new(),
            max_size,
        }
    }

    fn push(&mut self, old_content: String) {
        // When a new change is made, clear redo stack
        self.redo_stack.clear();
        
        // Add to undo stack
        self.undo_stack.push(old_content);
        
        // Trim if over max size
        while self.undo_stack.len() > self.max_size {
            self.undo_stack.remove(0);
        }
    }

    fn undo(&mut self, current_content: &str) -> Option<String> {
        if let Some(previous) = self.undo_stack.pop() {
            // Save current for redo
            self.redo_stack.push(current_content.to_string());
            Some(previous)
        } else {
            None
        }
    }

    fn redo(&mut self, current_content: &str) -> Option<String> {
        if let Some(next) = self.redo_stack.pop() {
            // Save current for undo
            self.undo_stack.push(current_content.to_string());
            Some(next)
        } else {
            None
        }
    }

    fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    fn undo_count(&self) -> usize {
        self.undo_stack.len()
    }

    fn redo_count(&self) -> usize {
        self.redo_stack.len()
    }
}

/// Per-file undo/redo record
struct FileRecord {
    /// The undo/redo stack
    stack: UndoStack,
    /// Current content state
    content: String,
    /// File path
    path: String,
}

impl FileRecord {
    fn new(path: String, initial_content: String, max_history: usize) -> Self {
        Self {
            stack: UndoStack::new(max_history),
            content: initial_content,
            path,
        }
    }

    fn push_change(&mut self, old_content: String, new_content: String) {
        // Only record if content actually changed
        if old_content != new_content {
            self.stack.push(old_content);
            self.content = new_content;
        }
    }

    fn undo(&mut self) -> Option<&String> {
        if let Some(previous) = self.stack.undo(&self.content) {
            self.content = previous;
            Some(&self.content)
        } else {
            None
        }
    }

    fn redo(&mut self) -> Option<&String> {
        if let Some(next) = self.stack.redo(&self.content) {
            self.content = next;
            Some(&self.content)
        } else {
            None
        }
    }

    fn can_undo(&self) -> bool {
        self.stack.can_undo()
    }

    fn can_redo(&self) -> bool {
        self.stack.can_redo()
    }

    fn get_state(&self) -> FileUndoState {
        FileUndoState {
            file_path: self.path.clone(),
            can_undo: self.can_undo(),
            can_redo: self.can_redo(),
            undo_count: self.stack.undo_count(),
            redo_count: self.stack.redo_count(),
        }
    }
}

/// Service for managing per-file undo/redo operations
pub struct UndoRedoService {
    /// Map of file path -> undo/redo record
    files: Mutex<HashMap<String, FileRecord>>,
    /// Maximum history size per file
    max_history: usize,
}

impl UndoRedoService {
    /// Create a new undo/redo service
    pub fn new() -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
            max_history: 100, // Default max history per file
        }
    }

    /// Create with custom max history
    #[allow(dead_code)]
    pub fn with_max_history(max_history: usize) -> Self {
        Self {
            files: Mutex::new(HashMap::new()),
            max_history,
        }
    }

    /// Initialize tracking for a file (called when file is opened)
    pub fn init_file(&self, file_path: &str, content: &str) {
        let mut files = self.files.lock().unwrap();
        if !files.contains_key(file_path) {
            files.insert(
                file_path.to_string(),
                FileRecord::new(file_path.to_string(), content.to_string(), self.max_history),
            );
        }
    }

    /// Record a change to a file
    /// This should be called whenever file content is modified programmatically
    pub fn record_change(&self, change: FileChange) -> UndoRedoResult<FileUndoState> {
        let mut files = self.files.lock().unwrap();
        
        let max_history = self.max_history;
        let record = files
            .entry(change.file_path.clone())
            .or_insert_with(|| FileRecord::new(change.file_path.clone(), change.old_content.clone(), max_history));

        record.push_change(change.old_content, change.new_content);

        Ok(record.get_state())
    }

    /// Undo the last change for a file
    pub fn undo(&self, file_path: &str) -> UndoRedoResult<(String, FileUndoState)> {
        let mut files = self.files.lock().unwrap();
        
        let record = files
            .get_mut(file_path)
            .ok_or_else(|| UndoRedoError::FileNotFound(file_path.to_string()))?;

        if !record.can_undo() {
            return Err(UndoRedoError::NothingToUndo(file_path.to_string()));
        }

        let content = record.undo()
            .ok_or_else(|| UndoRedoError::NothingToUndo(file_path.to_string()))?
            .clone();

        let state = record.get_state();
        Ok((content, state))
    }

    /// Redo the last undone change for a file
    pub fn redo(&self, file_path: &str) -> UndoRedoResult<(String, FileUndoState)> {
        let mut files = self.files.lock().unwrap();
        
        let record = files
            .get_mut(file_path)
            .ok_or_else(|| UndoRedoError::FileNotFound(file_path.to_string()))?;

        if !record.can_redo() {
            return Err(UndoRedoError::NothingToRedo(file_path.to_string()));
        }

        let content = record.redo()
            .ok_or_else(|| UndoRedoError::NothingToRedo(file_path.to_string()))?
            .clone();

        let state = record.get_state();
        Ok((content, state))
    }

    /// Get the current undo/redo state for a file
    pub fn get_state(&self, file_path: &str) -> Option<FileUndoState> {
        let files = self.files.lock().unwrap();
        files.get(file_path).map(|r| r.get_state())
    }

    /// Clear undo/redo history for a file
    pub fn clear_file(&self, file_path: &str) {
        let mut files = self.files.lock().unwrap();
        files.remove(file_path);
    }

    /// Clear all undo/redo history
    pub fn clear_all(&self) {
        let mut files = self.files.lock().unwrap();
        files.clear();
    }

    /// Undo and write to disk
    pub fn undo_and_save(&self, file_path: &str) -> UndoRedoResult<(String, FileUndoState)> {
        let (content, state) = self.undo(file_path)?;
        
        // Write to disk
        fs::write(file_path, &content)
            .map_err(|e| UndoRedoError::WriteError(format!("{}: {}", file_path, e)))?;
        
        // Invalidate file cache if available
        if let Ok(cache) = std::panic::catch_unwind(|| crate::file_cache::get_file_cache()) {
            cache.invalidate(file_path);
        }

        Ok((content, state))
    }

    /// Redo and write to disk
    pub fn redo_and_save(&self, file_path: &str) -> UndoRedoResult<(String, FileUndoState)> {
        let (content, state) = self.redo(file_path)?;
        
        // Write to disk
        fs::write(file_path, &content)
            .map_err(|e| UndoRedoError::WriteError(format!("{}: {}", file_path, e)))?;
        
        // Invalidate file cache if available
        if let Ok(cache) = std::panic::catch_unwind(|| crate::file_cache::get_file_cache()) {
            cache.invalidate(file_path);
        }

        Ok((content, state))
    }
}

impl Default for UndoRedoService {
    fn default() -> Self {
        Self::new()
    }
}

// Thread-safe for Tauri
unsafe impl Send for UndoRedoService {}
unsafe impl Sync for UndoRedoService {}

