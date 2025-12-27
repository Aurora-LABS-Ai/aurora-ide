use std::sync::Mutex;
use tauri::State;

use crate::db::{Database, ThreadState};

#[tauri::command]
pub fn save_thread(thread: ThreadState, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.threads()
        .save(&thread)
        .map_err(|e| format!("Failed to save thread: {:?}", e))
}

#[tauri::command]
pub fn get_thread(id: String, db: State<'_, Mutex<Database>>) -> Result<Option<ThreadState>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.threads()
        .get(&id)
        .map_err(|e| format!("Failed to get thread: {:?}", e))
}

#[tauri::command]
pub fn list_threads(db: State<'_, Mutex<Database>>) -> Result<Vec<ThreadState>, String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.threads()
        .list()
        .map_err(|e| format!("Failed to list threads: {:?}", e))
}

#[tauri::command]
pub fn delete_thread(id: String, db: State<'_, Mutex<Database>>) -> Result<(), String> {
    let db = db.lock().map_err(|e| e.to_string())?;
    db.threads()
        .delete(&id)
        .map_err(|e| format!("Failed to delete thread: {:?}", e))
}
