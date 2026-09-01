//! `aurora --cli` — the interactive terminal app.
//!
//! Everything else in [`super`] is a one-shot command: you type a full
//! instruction and get an answer. This is the other half — a place to *look
//! around* when you do not already know the model name, the thread id, or what
//! is currently running.
//!
//! ```text
//! ╔═ AURORA ═════════════════════════════════════════╗
//! ║  ❯ Dispatch a task      send work to Aurora      ║
//! ║    Models               142 across 21 providers  ║
//! ║    Conversations        13 in this project       ║
//! ║    Tasks                2 running                ║
//! ╚══════════════════════════════════════════════════╝
//! ```
//!
//! ## Architecture
//!
//! The Elm shape the `ratatui-tui` skill prescribes: state in [`App`], input
//! folded into a [`Message`], `update` applies it, `view` draws from state and
//! nothing else. Rendering never mutates and never does I/O, so a frame is
//! always a pure function of what `update` last decided.
//!
//! ## The terminal must be restored, including on a panic
//!
//! Raw mode and the alternate screen are process-global state owned by the
//! terminal emulator, not by this process. A panic that unwinds past the
//! restore leaves the user's shell with no echo, no line editing, and no
//! visible cursor — a session they have to close and reopen. [`run`] installs
//! a panic hook that restores first and only then panics, and restores again
//! on every normal exit path.

mod view;

use std::io::{self, Stdout};
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::layout::Rect;
use ratatui::backend::CrosstermBackend;
use ratatui::widgets::ListState;
use ratatui::Terminal;

use super::catalog::{Catalog, CatalogEntry};
use super::run::exit;
use super::threads::Threads;
use crate::agent_runtime::session_store::SessionSummary;

/// How long to block waiting for a key before redrawing anyway.
///
/// The redraw tick is what keeps a running task's elapsed time and status
/// moving without a key being pressed. 250ms is under the threshold where a
/// clock looks stuck, and idles at effectively zero CPU — `poll` sleeps rather
/// than spins.
const TICK: Duration = Duration::from_millis(250);

/// Which screen is showing.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Home,
    Models,
    Threads,
    Tasks,
}

/// What the home menu offers.
///
/// An enum rather than an index into a `Vec<&str>`, so `update` matches on
/// meaning and a reordered menu cannot silently change what Enter does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MenuItem {
    Dispatch,
    Models,
    Threads,
    Tasks,
    Quit,
}

impl MenuItem {
    /// Menu order, top to bottom.
    pub const ALL: [MenuItem; 5] = [
        MenuItem::Dispatch,
        MenuItem::Models,
        MenuItem::Threads,
        MenuItem::Tasks,
        MenuItem::Quit,
    ];

    pub fn label(self) -> &'static str {
        match self {
            MenuItem::Dispatch => "Dispatch a task",
            MenuItem::Models => "Models",
            MenuItem::Threads => "Conversations",
            MenuItem::Tasks => "Tasks",
            MenuItem::Quit => "Quit",
        }
    }
}

/// One thing the app can be told to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Message {
    Up,
    Down,
    /// Jump to the first row.
    Top,
    /// Jump to the last row.
    Bottom,
    /// Move by an arbitrary number of rows. Negative is up.
    ///
    /// [`Message::Up`] and [`Message::Down`] are this with ±1, kept as their
    /// own variants because they are what almost every binding means and
    /// reading `Up` at a call site beats reading `MoveBy(-1)`.
    MoveBy(i32),
    Select,
    /// Move the cursor to a row the pointer is over, without acting on it.
    Hover(usize),
    /// Click a row: move there and select it, in one message.
    ///
    /// One message rather than `Hover` followed by `Select`, because a click
    /// is one intent — and splitting it would let a row be selected while the
    /// cursor was still somewhere else if anything ran between them.
    Click(usize),
    /// Leave the current screen — back to Home, or quit from Home.
    Back,
    Quit,
    /// Re-read the task list and status.
    Refresh,
    /// Nothing; an input with no binding on this screen.
    None,
}

/// What the app wants the caller to do after it exits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exit {
    /// Plain quit.
    Done,
    /// The user chose "Dispatch a task"; the caller should run the dispatch
    /// flow now that the alternate screen is gone, using whatever
    /// [`App::chosen_model`] and [`App::chosen_thread`] hold.
    ///
    /// Handing this back rather than dispatching inside the TUI is deliberate:
    /// composing a prompt needs a real text field, and the dispatch flow
    /// already has good ones in [`super::run`]. Running them under an
    /// alternate screen would mean re-implementing prompts that already exist,
    /// worse, inside a raw-mode terminal.
    Dispatch,
    /// The user picked a task to watch; the caller should follow its
    /// transcript once the terminal is restored.
    Watch(String),
}

/// Everything on screen.
pub struct App {
    pub screen: Screen,
    /// Selected row on the current screen.
    pub cursor: usize,
    pub should_quit: bool,
    pub exit: Exit,

    pub workspace: Option<String>,
    pub catalog: Option<Catalog>,
    pub threads: Vec<SessionSummary>,
    pub tasks: Vec<super::run::TaskSummary>,
    pub aurora_running: bool,
    /// Why the catalogue could not be read, when it could not.
    pub catalog_error: Option<String>,
    pub last_refresh: Instant,

    /// The model picked from the Models list, if any.
    ///
    /// Choosing a model here *stages* it for the next dispatch rather than
    /// writing it to Aurora's settings. Changing the app's default model from
    /// a browse screen would be a lasting change made by someone looking
    /// around — and it would silently repoint the Agent Window a user has open
    /// in front of them.
    pub chosen_model: Option<CatalogEntry>,

    /// The conversation picked from the Conversations list, if any.
    pub chosen_thread: Option<SessionSummary>,

    /// Scroll position of the current list.
    ///
    /// Genuinely app state, not a rendering detail: it persists between
    /// frames, it decides which rows exist on screen, and a mouse click has to
    /// be resolved against it. Keeping it here is what lets a 95-model list
    /// scroll at all — a `List` rendered without one draws the first screenful
    /// forever, and every row past it becomes unreachable.
    pub list_state: ListState,
}

impl App {
    /// Read everything the home screen summarises.
    ///
    /// Loaded once up front rather than per-frame: `view` must stay pure, and
    /// a SQLite read inside a 250ms redraw would be both wasteful and a source
    /// of frames that disagree with each other.
    pub fn load(workspace: Option<String>) -> Self {
        let (catalog, catalog_error) = match Catalog::load() {
            Ok(catalog) => (Some(catalog), None),
            Err(error) => (None, Some(error.to_string())),
        };

        let threads = Threads::load(workspace.as_deref())
            .map(|threads| threads.all)
            .unwrap_or_default();

        let tasks = super::run::collect_task_summaries().unwrap_or_default();

        Self {
            screen: Screen::Home,
            cursor: 0,
            should_quit: false,
            exit: Exit::Done,
            workspace,
            catalog,
            threads,
            tasks,
            aurora_running: super::presence::aurora_is_running(),
            catalog_error,
            last_refresh: Instant::now(),
            chosen_model: None,
            chosen_thread: None,
            list_state: ListState::default().with_selected(Some(0)),
        }
    }

    /// Models to show, in catalogue order.
    pub fn models(&self) -> &[CatalogEntry] {
        self.catalog
            .as_ref()
            .map(|catalog| catalog.entries.as_slice())
            .unwrap_or(&[])
    }

    /// How many rows the current screen has.
    fn row_count(&self) -> usize {
        match self.screen {
            Screen::Home => MenuItem::ALL.len(),
            Screen::Models => self.models().len(),
            Screen::Threads => self.threads.len(),
            Screen::Tasks => self.tasks.len(),
        }
    }

    /// The highlighted menu item, when Home is showing.
    pub fn selected_menu(&self) -> MenuItem {
        MenuItem::ALL
            .get(self.cursor)
            .copied()
            .unwrap_or(MenuItem::Quit)
    }

    /// Move the cursor by `delta` rows.
    ///
    /// Single steps wrap; larger jumps clamp. The difference is deliberate: on
    /// a five-item menu, wrapping means reaching "Quit" is one press up rather
    /// than four. On a 95-row list, a wheel scroll that teleports from the
    /// bottom to the top is disorienting — a wheel should run out of list, the
    /// way it does everywhere else.
    fn move_by(&mut self, delta: i32) {
        let rows = self.row_count();
        if rows == 0 {
            return;
        }
        let rows_i = rows as i32;
        let current = self.cursor as i32;

        self.cursor = if delta.abs() == 1 {
            // `rem_euclid` rather than `%`, which in Rust keeps the sign and
            // would produce -1 at the top of the list.
            (current + delta).rem_euclid(rows_i) as usize
        } else {
            (current + delta).clamp(0, rows_i - 1) as usize
        };
    }

    /// Apply one message.
    pub fn update(&mut self, message: Message) {
        let rows = self.row_count();
        match message {
            Message::Up => self.move_by(-1),
            Message::Down => self.move_by(1),
            Message::MoveBy(delta) => self.move_by(delta),
            Message::Top => self.cursor = 0,
            Message::Bottom => self.cursor = rows.saturating_sub(1),
            Message::Select => self.select(),
            // A pointer past the last row is over the block's empty space, not
            // over the final item — moving the cursor there would make the
            // highlight follow the mouse into blank areas.
            Message::Hover(index) => {
                if index < rows {
                    self.cursor = index;
                }
            }
            Message::Click(index) => {
                if index < rows {
                    self.cursor = index;
                    self.select();
                }
            }
            Message::Back => {
                if self.screen == Screen::Home {
                    self.should_quit = true;
                } else {
                    // Order matters: the cursor is derived from the screen
                    // being LEFT, so it has to be read before `screen` is
                    // reassigned. Doing it the other way round resolves every
                    // exit to the same menu item.
                    let previous = self.menu_index_for_previous();
                    self.screen = Screen::Home;
                    self.cursor = previous;
                    *self.list_state.offset_mut() = 0;
                }
            }
            Message::Quit => self.should_quit = true,
            Message::Refresh => self.refresh(),
            Message::None => {}
        }
        // One place the scroll position is kept in step with the cursor.
        // Doing it per-arm is how a new movement message eventually ships
        // moving the highlight without moving the view.
        self.sync_scroll();
    }

    /// Point the scroll state at the current row.
    ///
    /// The widget derives its own offset from this, scrolling only as far as
    /// it must to bring the row on screen — so the viewport stays put while
    /// the cursor moves inside it, and follows only at the edges.
    fn sync_scroll(&mut self) {
        if self.row_count() == 0 {
            self.list_state.select(None);
        } else {
            self.list_state.select(Some(self.cursor));
        }
    }

    /// Where the visible window starts, so a click can be resolved to a row.
    pub fn scroll_offset(&self) -> usize {
        self.list_state.offset()
    }

    /// Where the home cursor should sit after backing out of `self.screen`.
    ///
    /// Must be read *before* `screen` is set back to Home.
    fn menu_index_for_previous(&self) -> usize {
        let wanted = match self.screen {
            Screen::Models => MenuItem::Models,
            Screen::Threads => MenuItem::Threads,
            Screen::Tasks => MenuItem::Tasks,
            Screen::Home => MenuItem::Dispatch,
        };
        MenuItem::ALL
            .iter()
            .position(|item| *item == wanted)
            .unwrap_or(0)
    }

    fn select(&mut self) {
        match self.screen {
            Screen::Home => {}
            // Picking from a list *stages* the choice and returns to the menu,
            // where "Dispatch a task" then shows what it will use. That is the
            // answer to "why is this list here": every row is a choice you can
            // make, and none of them changes anything outside this session
            // until you dispatch.
            Screen::Models => {
                self.chosen_model = self.models().get(self.cursor).cloned();
                self.back_to_menu(MenuItem::Models);
                return;
            }
            Screen::Threads => {
                self.chosen_thread = self.threads.get(self.cursor).cloned();
                self.back_to_menu(MenuItem::Threads);
                return;
            }
            Screen::Tasks => {
                // Watching is the only thing you can usefully do to a task
                // from here, and it is what the row is for.
                if let Some(task) = self.tasks.get(self.cursor) {
                    self.exit = Exit::Watch(task.id.clone());
                    self.should_quit = true;
                }
                return;
            }
        }
        match self.selected_menu() {
            MenuItem::Dispatch => {
                self.exit = Exit::Dispatch;
                self.should_quit = true;
            }
            MenuItem::Models => self.open(Screen::Models),
            MenuItem::Threads => self.open(Screen::Threads),
            MenuItem::Tasks => {
                self.refresh();
                self.open(Screen::Tasks);
            }
            MenuItem::Quit => self.should_quit = true,
        }
    }

    /// Return to the menu with the cursor on `item`.
    fn back_to_menu(&mut self, item: MenuItem) {
        self.screen = Screen::Home;
        self.cursor = MenuItem::ALL
            .iter()
            .position(|candidate| *candidate == item)
            .unwrap_or(0);
        *self.list_state.offset_mut() = 0;
        self.sync_scroll();
    }

    /// Switch screens, starting at the top of the new list.
    ///
    /// The scroll offset is reset explicitly rather than left for the widget
    /// to correct: carrying a previous list's offset into a shorter one shows
    /// a screen scrolled past its own content until the first redraw fixes it.
    fn open(&mut self, screen: Screen) {
        self.screen = screen;
        self.cursor = 0;
        *self.list_state.offset_mut() = 0;
    }

    /// Re-read the things that change while the app is open.
    ///
    /// Tasks and presence only. The model catalogue and the thread list change
    /// when the *user* does something in the window, which is not something
    /// that happens while they are looking at this.
    fn refresh(&mut self) {
        self.tasks = super::run::collect_task_summaries().unwrap_or_default();
        self.aurora_running = super::presence::aurora_is_running();
        self.last_refresh = Instant::now();
        let rows = self.row_count();
        if self.cursor >= rows {
            self.cursor = rows.saturating_sub(1);
        }
    }
}

/// Translate a key press into a message, given the current screen.
pub fn key_to_message(key: KeyEvent, screen: Screen) -> Message {
    // Windows reports both press AND release; acting on both moves the cursor
    // two rows per keystroke.
    if key.kind != KeyEventKind::Press {
        return Message::None;
    }

    // Ctrl-C is the terminal's universal "stop", and a TUI that ignores it is
    // one the user has to kill from another window.
    if key.modifiers.contains(KeyModifiers::CONTROL) && matches!(key.code, KeyCode::Char('c')) {
        return Message::Quit;
    }

    match key.code {
        KeyCode::Up | KeyCode::Char('k') => Message::Up,
        KeyCode::Down | KeyCode::Char('j') => Message::Down,
        KeyCode::Home | KeyCode::Char('g') => Message::Top,
        KeyCode::End | KeyCode::Char('G') => Message::Bottom,
        // A 95-row model list needs a bigger step than one.
        KeyCode::PageDown => Message::MoveBy(PAGE_ROWS),
        KeyCode::PageUp => Message::MoveBy(-PAGE_ROWS),
        KeyCode::Enter | KeyCode::Char(' ') => Message::Select,
        KeyCode::Char('r') => Message::Refresh,
        KeyCode::Esc | KeyCode::Left | KeyCode::Char('h') => Message::Back,
        // `q` quits outright from anywhere; Esc is the gentler "go back".
        KeyCode::Char('q') => {
            if screen == Screen::Home {
                Message::Quit
            } else {
                Message::Back
            }
        }
        _ => Message::None,
    }
}

/// Rows one wheel notch moves.
///
/// Three is the conventional notch on every platform. One would make a
/// 95-model list an exercise in scrolling.
const WHEEL_ROWS: i32 = 3;

/// Rows PageUp/PageDown move.
const PAGE_ROWS: i32 = 10;

/// Translate a mouse event into a message.
///
/// `area` is the frame's current size and `offset` the list's current scroll
/// position. Both are passed in rather than cached, so a click is resolved
/// against the layout and the scroll it was actually aimed at — after a resize
/// or a scroll, stale geometry sends clicks to the wrong row.
pub fn mouse_to_message(
    mouse: MouseEvent,
    screen: Screen,
    area: Rect,
    offset: usize,
) -> Message {
    // A visible line maps to a list row only once the scroll position is added
    // — the third line on screen is the third row only while the list is at
    // the top.
    let row_at = |column, row| view::row_at(area, screen, column, row).map(|index| index + offset);

    match mouse.kind {
        // Act on press, not release. Release-to-activate would mean a click
        // that started on a row and was dragged off it still fires — the
        // opposite of what dragging away from a button is for.
        MouseEventKind::Down(MouseButton::Left) => match row_at(mouse.column, mouse.row) {
            Some(index) => Message::Click(index),
            None => Message::None,
        },
        // Pointer movement only moves the highlight. Hover must never act.
        MouseEventKind::Moved | MouseEventKind::Drag(MouseButton::Left) => {
            match row_at(mouse.column, mouse.row) {
                Some(index) => Message::Hover(index),
                None => Message::None,
            }
        }
        MouseEventKind::ScrollDown => Message::MoveBy(WHEEL_ROWS),
        MouseEventKind::ScrollUp => Message::MoveBy(-WHEEL_ROWS),
        _ => Message::None,
    }
}

/// Run the interactive app over an already-loaded [`App`].
///
/// Takes the app by reference so the caller can read [`App::exit`] afterwards
/// — "the user chose Dispatch" is a decision the TUI makes and the caller
/// acts on, once the terminal has been handed back.
pub fn run_with(app: &mut App) -> i32 {
    if !io::IsTerminal::is_terminal(&io::stdout()) {
        eprintln!("aurora --cli needs a terminal. For scripted use, see `aurora agent --json`.");
        return exit::USAGE;
    }

    let mut terminal = match enter() {
        Ok(terminal) => terminal,
        Err(error) => {
            eprintln!("could not start the interactive view: {error}");
            return exit::USAGE;
        }
    };

    let result = event_loop(&mut terminal, app);

    // Restore before anything else prints, so whatever the caller does next
    // runs in a normal terminal.
    let _ = leave(&mut terminal);

    if let Err(error) = result {
        eprintln!("interactive view failed: {error}");
        return exit::USAGE;
    }

    exit::OK
}

/// The draw/read loop.
fn event_loop(
    terminal: &mut Terminal<CrosstermBackend<Stdout>>,
    app: &mut App,
) -> io::Result<()> {
    loop {
        terminal.draw(|frame| view::draw(frame, app))?;

        if event::poll(TICK)? {
            match event::read()? {
                Event::Key(key) => {
                    let message = key_to_message(key, app.screen);
                    app.update(message);
                }
                Event::Mouse(mouse) => {
                    // `Terminal::size` asks the terminal, so a click is tested
                    // against the window as it is right now — not against
                    // whatever it was when the last frame was drawn.
                    let size = terminal.size()?;
                    let area = Rect::new(0, 0, size.width, size.height);
                    let message =
                        mouse_to_message(mouse, app.screen, area, app.scroll_offset());
                    app.update(message);
                }
                // A resize needs nothing but the redraw at the top of the loop.
                _ => {}
            }
        } else if app.screen == Screen::Tasks && app.last_refresh.elapsed() > Duration::from_secs(2)
        {
            // Only the task list has state that moves on its own.
            app.update(Message::Refresh);
        }

        if app.should_quit {
            return Ok(());
        }
    }
}

/// Take over the terminal.
///
/// Mouse capture is enabled explicitly. Without it the terminal handles clicks
/// itself and the application never sees them — which is why the menu ignored
/// the mouse until it was turned on.
///
/// It has a cost worth knowing about: while captured, drag-to-select stops
/// selecting text, because the drags are being delivered here instead. Every
/// mainstream terminal keeps a way out — hold **Shift** while dragging to
/// select and copy as usual.
fn enter() -> io::Result<Terminal<CrosstermBackend<Stdout>>> {
    install_panic_restore();
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    Terminal::new(CrosstermBackend::new(stdout))
}

/// Give it back.
///
/// Mouse capture is released before the alternate screen, in the reverse order
/// it was taken. Leaving it on would follow the user back into their shell,
/// where every click would emit escape sequences into the prompt.
fn leave(terminal: &mut Terminal<CrosstermBackend<Stdout>>) -> io::Result<()> {
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        DisableMouseCapture,
        LeaveAlternateScreen
    )?;
    terminal.show_cursor()
}

/// Restore the terminal before a panic prints.
///
/// Without this, a panic inside the draw loop unwinds with raw mode still on
/// and the alternate screen still up: the backtrace scrolls sideways in a
/// screen that vanishes, and the user is left in a shell with no echo. Restore
/// first, print second.
fn install_panic_restore() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), DisableMouseCapture, LeaveAlternateScreen);
        previous(info);
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_with(rows: usize) -> App {
        let mut app = App {
            screen: Screen::Threads,
            cursor: 0,
            should_quit: false,
            exit: Exit::Done,
            workspace: None,
            catalog: None,
            threads: Vec::new(),
            tasks: Vec::new(),
            aurora_running: false,
            catalog_error: None,
            last_refresh: Instant::now(),
            chosen_model: None,
            chosen_thread: None,
            list_state: ListState::default().with_selected(Some(0)),
        };
        app.threads = (0..rows)
            .map(|index| SessionSummary {
                id: format!("thread-{index}"),
                title: format!("conversation {index}"),
                message_count: 1,
                preview: String::new(),
                workspace_root: None,
                model: None,
                pinned: false,
                archived_at: None,
                created_at: "2026-09-01T10:00:00Z".to_string(),
                updated_at: "2026-09-01T10:00:00Z".to_string(),
            })
            .collect();
        app
    }

    fn home() -> App {
        let mut app = app_with(0);
        app.screen = Screen::Home;
        app
    }

    fn press(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn the_cursor_wraps_at_both_ends() {
        // A five-item menu with hard stops makes reaching the last item four
        // presses instead of one.
        let mut app = home();
        app.update(Message::Up);
        assert_eq!(app.cursor, MenuItem::ALL.len() - 1);
        app.update(Message::Down);
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn an_empty_list_does_not_move_the_cursor() {
        // Dividing by zero rows is the obvious crash here.
        let mut app = app_with(0);
        app.update(Message::Down);
        app.update(Message::Up);
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn top_and_bottom_jump() {
        let mut app = app_with(10);
        app.update(Message::Bottom);
        assert_eq!(app.cursor, 9);
        app.update(Message::Top);
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn selecting_a_menu_item_opens_its_screen() {
        let mut app = home();
        app.cursor = MenuItem::ALL
            .iter()
            .position(|item| *item == MenuItem::Models)
            .expect("models is in the menu");
        app.update(Message::Select);
        assert_eq!(app.screen, Screen::Models);
        assert_eq!(app.cursor, 0, "a new screen starts at its first row");
    }

    #[test]
    fn dispatch_leaves_the_tui_rather_than_prompting_inside_it() {
        // Composing a prompt needs a real text field; the dispatch flow
        // already has one, outside the alternate screen.
        let mut app = home();
        app.cursor = 0;
        assert_eq!(app.selected_menu(), MenuItem::Dispatch);
        app.update(Message::Select);
        assert!(app.should_quit);
        assert_eq!(app.exit, Exit::Dispatch);
    }

    #[test]
    fn back_returns_to_the_menu_item_that_opened_the_screen() {
        let mut app = home();
        app.cursor = MenuItem::ALL
            .iter()
            .position(|item| *item == MenuItem::Tasks)
            .expect("tasks is in the menu");
        app.update(Message::Select);
        assert_eq!(app.screen, Screen::Tasks);

        app.update(Message::Back);
        assert_eq!(app.screen, Screen::Home);
        assert_eq!(
            app.selected_menu(),
            MenuItem::Tasks,
            "leaving a list should put you back where you were"
        );
    }

    #[test]
    fn back_from_home_quits() {
        let mut app = home();
        app.update(Message::Back);
        assert!(app.should_quit);
        assert_eq!(app.exit, Exit::Done, "Esc is a quit, not a dispatch");
    }

    #[test]
    fn choosing_a_conversation_stages_it_and_returns_to_the_menu() {
        // A list whose rows do nothing has no reason to exist. Picking one
        // stages it for the next dispatch and takes you back to the menu,
        // where the choice is visible.
        let mut app = app_with(3);
        app.cursor = 1;
        app.update(Message::Select);

        assert_eq!(
            app.chosen_thread.as_ref().map(|summary| summary.id.as_str()),
            Some("thread-1")
        );
        assert_eq!(app.screen, Screen::Home);
        assert_eq!(app.selected_menu(), MenuItem::Threads);
        assert!(!app.should_quit);
    }

    #[test]
    fn choosing_a_conversation_changes_nothing_outside_this_session() {
        // Staging, not saving. Repointing the app's real settings from a
        // browse screen would change a window the user has open in front of
        // them.
        let mut app = app_with(2);
        app.update(Message::Select);
        assert!(app.chosen_thread.is_some());
        assert_eq!(app.exit, Exit::Done, "picking must not dispatch by itself");
    }

    #[test]
    fn clicking_a_conversation_stages_it_too() {
        // Same behaviour by mouse as by keyboard — the click was the case
        // that looked broken.
        let mut app = app_with(3);
        app.update(Message::Click(2));
        assert_eq!(
            app.chosen_thread.as_ref().map(|summary| summary.id.as_str()),
            Some("thread-2")
        );
        assert_eq!(app.screen, Screen::Home);
    }

    #[test]
    fn choosing_a_task_watches_it() {
        let mut app = app_with(0);
        app.screen = Screen::Tasks;
        app.tasks = vec![crate::cli_delegate::run::TaskSummary {
            id: "20260901T142233-7f3a91".to_string(),
            status: "running",
            workspace_path: r"E:\project".to_string(),
            prompt: "do it".to_string(),
            model: None,
            created_at: "2026-09-01T14:22:33Z".to_string(),
        }];
        app.update(Message::Select);
        assert_eq!(app.exit, Exit::Watch("20260901T142233-7f3a91".to_string()));
        assert!(app.should_quit);
    }

    #[test]
    fn selecting_an_empty_list_does_nothing() {
        // No rows means no choice; indexing here is the obvious crash.
        let mut app = app_with(0);
        app.update(Message::Select);
        assert!(app.chosen_thread.is_none());
        assert!(!app.should_quit);
    }

    #[test]
    fn key_release_is_ignored() {
        // Windows reports press AND release; acting on both moves two rows per
        // keystroke.
        let mut release = press(KeyCode::Down);
        release.kind = KeyEventKind::Release;
        assert_eq!(key_to_message(release, Screen::Home), Message::None);
    }

    #[test]
    fn ctrl_c_always_quits() {
        let key = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(key_to_message(key, Screen::Home), Message::Quit);
        assert_eq!(key_to_message(key, Screen::Models), Message::Quit);
    }

    #[test]
    fn q_backs_out_of_a_list_but_quits_from_home() {
        let key = press(KeyCode::Char('q'));
        assert_eq!(key_to_message(key, Screen::Home), Message::Quit);
        assert_eq!(key_to_message(key, Screen::Models), Message::Back);
    }

    #[test]
    fn vim_keys_work_alongside_arrows() {
        assert_eq!(key_to_message(press(KeyCode::Char('j')), Screen::Home), Message::Down);
        assert_eq!(key_to_message(press(KeyCode::Down), Screen::Home), Message::Down);
        assert_eq!(key_to_message(press(KeyCode::Char('k')), Screen::Home), Message::Up);
        assert_eq!(key_to_message(press(KeyCode::Up), Screen::Home), Message::Up);
    }

    #[test]
    fn an_unbound_key_does_nothing() {
        assert_eq!(key_to_message(press(KeyCode::Char('z')), Screen::Home), Message::None);
    }

    // ── mouse ───────────────────────────────────────────────────────────

    fn click_at(row: u16) -> MouseEvent {
        MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Left),
            column: 20,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn move_to(row: u16) -> MouseEvent {
        MouseEvent {
            kind: MouseEventKind::Moved,
            column: 20,
            row,
            modifiers: KeyModifiers::NONE,
        }
    }

    fn frame() -> Rect {
        Rect::new(0, 0, 90, 28)
    }

    /// Hit-test at the top of the list, where most cases live.
    fn at_top(mouse: MouseEvent, screen: Screen) -> Message {
        mouse_to_message(mouse, screen, frame(), 0)
    }

    #[test]
    fn clicking_a_menu_row_opens_it() {
        // The bug this closes: mouse capture was never enabled, so clicks
        // never reached the app at all.
        let mut app = home();
        let index = MenuItem::ALL
            .iter()
            .position(|item| *item == MenuItem::Models)
            .expect("models is in the menu");
        let message = at_top(click_at(10 + index as u16), Screen::Home);
        assert_eq!(message, Message::Click(index));
        app.update(message);
        assert_eq!(app.screen, Screen::Models);
    }

    #[test]
    fn hovering_moves_the_highlight_but_does_not_act() {
        // Opening a screen because the pointer crossed it would make the app
        // unusable with a mouse anywhere near the terminal.
        let mut app = home();
        let message = at_top(move_to(12), Screen::Home);
        assert_eq!(message, Message::Hover(2));
        app.update(message);
        assert_eq!(app.cursor, 2);
        assert_eq!(app.screen, Screen::Home, "hover must never open a screen");
        assert!(!app.should_quit);
    }

    #[test]
    fn clicking_empty_space_does_nothing() {
        let mut app = home();
        app.cursor = 1;
        // Below the five menu items, inside the block's empty area.
        let message = at_top(click_at(20), Screen::Home);
        app.update(message);
        assert_eq!(app.cursor, 1, "the cursor should not have moved");
        assert_eq!(app.screen, Screen::Home);
    }

    #[test]
    fn clicking_the_logo_does_nothing() {
        let message = at_top(click_at(2), Screen::Home);
        assert_eq!(message, Message::None);
    }

    #[test]
    fn a_click_past_the_last_row_is_ignored_not_clamped() {
        // Clamping to the last item would make a click in dead space quit,
        // since Quit is last.
        let mut app = home();
        app.update(Message::Click(99));
        assert!(!app.should_quit);
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn clicking_quit_quits() {
        let mut app = home();
        let index = MenuItem::ALL.len() - 1;
        assert_eq!(MenuItem::ALL[index], MenuItem::Quit);
        app.update(Message::Click(index));
        assert!(app.should_quit);
    }

    #[test]
    fn the_wheel_scrolls_the_selection() {
        let wheel = |kind| MouseEvent {
            kind,
            column: 20,
            row: 10,
            modifiers: KeyModifiers::NONE,
        };
        // A notch moves three rows, the platform convention. One row would
        // make a 95-model list an exercise in scrolling.
        assert_eq!(
            at_top(wheel(MouseEventKind::ScrollDown), Screen::Home),
            Message::MoveBy(WHEEL_ROWS)
        );
        assert_eq!(
            at_top(wheel(MouseEventKind::ScrollUp), Screen::Home),
            Message::MoveBy(-WHEEL_ROWS)
        );
    }

    #[test]
    fn a_right_click_does_not_select() {
        // Only the left button activates; a right-click is not an "open".
        let right = MouseEvent {
            kind: MouseEventKind::Down(MouseButton::Right),
            column: 20,
            row: 10,
            modifiers: KeyModifiers::NONE,
        };
        assert_eq!(at_top(right, Screen::Home), Message::None);
    }

    #[test]
    fn a_click_on_a_scrolled_list_hits_the_right_row() {
        // The bug this closes: with the list scrolled down, the third VISIBLE
        // line is not the third row. Without adding the offset every click on
        // a long list lands on the wrong model.
        let scrolled = mouse_to_message(click_at(9), Screen::Models, frame(), 40);
        assert_eq!(scrolled, Message::Click(40));

        let unscrolled = mouse_to_message(click_at(9), Screen::Models, frame(), 0);
        assert_eq!(unscrolled, Message::Click(0));
    }

    #[test]
    fn the_wheel_clamps_rather_than_wrapping() {
        // Wrapping a wheel scroll from the bottom of a 95-row list back to the
        // top is disorienting; a wheel should run out of list.
        let mut app = app_with(10);
        app.update(Message::Bottom);
        app.update(Message::MoveBy(WHEEL_ROWS));
        assert_eq!(app.cursor, 9);

        app.update(Message::Top);
        app.update(Message::MoveBy(-WHEEL_ROWS));
        assert_eq!(app.cursor, 0);
    }

    #[test]
    fn single_steps_still_wrap() {
        // The five-item menu is why: reaching "Quit" should be one press up.
        let mut app = home();
        app.update(Message::Up);
        assert_eq!(app.cursor, MenuItem::ALL.len() - 1);
    }

    #[test]
    fn the_scroll_position_follows_the_cursor() {
        // Without this the highlight moves off-screen and the list looks
        // frozen — the exact symptom of rendering a `List` with no state.
        let mut app = app_with(95);
        app.update(Message::Bottom);
        assert_eq!(app.list_state.selected(), Some(94));
    }

    #[test]
    fn menu_labels_are_all_present() {
        // Guards against a variant added to the enum without a label.
        for item in MenuItem::ALL {
            assert!(!item.label().is_empty(), "{item:?} has no label");
        }
    }
}
