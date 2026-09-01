//! Drawing the interactive app.
//!
//! Pure: every function here reads [`App`] and writes to a frame. No I/O, no
//! mutation. A frame is therefore always a faithful picture of what `update`
//! last decided, and a redraw can never disagree with the previous one.
//!
//! Colours come from ratatui's `Stylize` helpers and the terminal's *named*
//! palette, never RGB triples — the named colours are the ones a user's own
//! terminal theme remaps, so someone on a light background gets their cyan
//! rather than one chosen against a dark terminal.

use ratatui::layout::{Alignment, Constraint, Layout, Rect};
use ratatui::style::Stylize;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, List, ListItem, Padding, Paragraph};
use ratatui::Frame;

use super::{App, MenuItem, Screen};
use crate::cli_delegate::list::short_id;
use crate::cli_delegate::threads::display_title;

/// Aurora's gold, sampled from the app icon (`src-tauri/icons/icon.png`): a
/// lit gold chevron on charcoal, brightest at the top edge and falling to a
/// deep amber bevel underneath.
///
/// Truecolour rather than one of the sixteen named colours, because this is a
/// *brand* mark. Everywhere else in this app defers to the user's terminal
/// theme — the whole point of the named palette — but a logo that turns green
/// on someone's colour scheme is not a logo. Terminals without 24-bit colour
/// approximate it to the nearest gold, which is the right failure.
const GOLD_GRADIENT: [(u8, u8, u8); 6] = [
    (255, 227, 168),
    (255, 217, 138),
    (240, 192, 112),
    (224, 169, 74),
    (200, 144, 56),
    (168, 120, 40),
];

/// Rows the block wordmark is drawn in.
///
/// The app icon beside it is sized from this, so the two always line up — see
/// [`super::logo::ICON_ROWS`].
pub(super) const LOGO_ROWS: usize = 6;

/// The wordmark, in the classic six-row block style.
///
/// Only drawn when the terminal is wide enough to hold it without wrapping —
/// a wrapped logo is worse than no logo. [`COMPACT_LOGO`] takes over below
/// that, and neither is load-bearing: the app is fully usable with the header
/// collapsed to a single line.
pub(super) const LOGO: [&str; LOGO_ROWS] = [
    " █████╗ ██╗   ██╗██████╗  ██████╗ ██████╗  █████╗ ",
    "██╔══██╗██║   ██║██╔══██╗██╔═══██╗██╔══██╗██╔══██╗",
    "███████║██║   ██║██████╔╝██║   ██║██████╔╝███████║",
    "██╔══██║██║   ██║██╔══██╗██║   ██║██╔══██╗██╔══██║",
    "██║  ██║╚██████╔╝██║  ██║╚██████╔╝██║  ██║██║  ██║",
    "╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝",
];

/// Width the full logo needs, plus the frame around it.
const LOGO_WIDTH: u16 = 54;

/// Height the full logo block occupies, including its blank line.
pub(super) const LOGO_HEIGHT: u16 = 8;

/// What a narrow terminal gets instead.
const COMPACT_LOGO: &str = "AURORA";

/// Whether the frame is too small to lay out at all.
///
/// Below this, `Layout` starts handing out zero-height regions and every
/// widget silently disappears — a scrambled screen rather than a small one.
fn too_small(area: Rect) -> bool {
    area.height < 8 || area.width < 30
}

/// Height the header gets: the full logo when there is room, else one line.
fn header_height(area: Rect) -> u16 {
    if area.width >= LOGO_WIDTH && area.height >= 20 {
        LOGO_HEIGHT
    } else {
        2
    }
}

/// Split a frame into its four bands. The single definition of the layout, so
/// drawing and mouse hit-testing can never disagree about where things are.
fn bands(area: Rect) -> [Rect; 4] {
    Layout::vertical([
        Constraint::Length(header_height(area)),
        Constraint::Fill(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(area)
}

/// Which list row is under a point, if any.
///
/// The counterpart to [`draw`]: the mouse reports absolute cell coordinates,
/// and this turns them back into the row index the click meant. It re-derives
/// the layout from the frame size rather than reading anything cached, so a
/// click after a resize cannot act on stale geometry.
///
/// Horizontal bounds are the block's, not the padded content's — deliberately
/// forgiving. Someone clicking a menu item aims at the words; requiring the
/// pointer to land inside the text's own padding would make the left margin a
/// dead zone for no reason.
pub fn row_at(area: Rect, screen: Screen, column: u16, row: u16) -> Option<usize> {
    if too_small(area) {
        return None;
    }
    let [_, body, _, _] = bands(area);

    // Top padding differs by screen: the menu block breathes, the list blocks
    // start immediately under their border.
    let pad_top = if screen == Screen::Home { 1 } else { 0 };

    let first = body.y.checked_add(1)?.checked_add(pad_top)?;
    // The last drawable line, excluding the bottom border.
    let last = body.y + body.height.saturating_sub(1);
    if row < first || row >= last {
        return None;
    }

    let left = body.x + 1;
    let right = body.x + body.width.saturating_sub(1);
    if column < left || column >= right {
        return None;
    }

    Some((row - first) as usize)
}

/// Draw one frame.
///
/// Takes `&mut App` for one reason: the list widget owns its scroll offset and
/// computes it during render, writing back into [`App::list_state`]. That is
/// what makes a 95-row list scroll — and it is genuine app state, since the
/// next click has to be resolved against it. No business logic runs here.
pub fn draw(frame: &mut Frame, app: &mut App) {
    let area = frame.area();

    // A terminal too small for any useful layout gets a message rather than a
    // scrambled one.
    if too_small(area) {
        frame.render_widget(
            Paragraph::new("Terminal too small — make the window bigger.")
                .dim()
                .alignment(Alignment::Center),
            area,
        );
        return;
    }

    let [header, body, status, help] = bands(area);
    let header_height = header.height;

    draw_header(frame, header, header_height == LOGO_HEIGHT);
    draw_status(frame, status, app);
    draw_help(frame, help, app);
    // Last, because it is the one that borrows `app` mutably.
    match app.screen {
        Screen::Home => draw_home(frame, body, app),
        Screen::Models => draw_models(frame, body, app),
        Screen::Threads => draw_threads(frame, body, app),
        Screen::Tasks => draw_tasks(frame, body, app),
    }
}

fn draw_header(frame: &mut Frame, area: Rect, full: bool) {
    let version = env!("CARGO_PKG_VERSION");
    let gold = |index: usize| {
        let (r, g, b) = GOLD_GRADIENT[index.min(GOLD_GRADIENT.len() - 1)];
        ratatui::style::Color::Rgb(r, g, b)
    };

    if !full {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                COMPACT_LOGO.bold().fg(gold(1)),
                format!("  v{version}").dim(),
            ]))
            .alignment(Alignment::Center),
            area,
        );
        return;
    }

    // One gradient step per row, brightest at the top — the falloff the app
    // icon's own glow has.
    let mut lines: Vec<Line> = LOGO
        .iter()
        .enumerate()
        .map(|(index, row)| Line::from((*row).fg(gold(index))).alignment(Alignment::Center))
        .collect();

    lines.push(
        Line::from(vec![
            "agent delegate".dim(),
            "  ·  ".dim(),
            format!("v{version}").dim(),
        ])
        .alignment(Alignment::Center),
    );
    frame.render_widget(Paragraph::new(lines), area);
}

fn draw_home(frame: &mut Frame, area: Rect, app: &mut App) {
    let items: Vec<ListItem> = MenuItem::ALL
        .iter()
        .enumerate()
        .map(|(index, item)| {
            let selected = index == app.cursor;
            let marker = if selected { "❯ " } else { "  " };
            let label = if selected {
                item.label().bold().cyan()
            } else {
                item.label().into()
            };
            ListItem::new(Line::from(vec![
                marker.cyan(),
                label,
                // Pad so the descriptions line up regardless of label length.
                " ".repeat(20usize.saturating_sub(item.label().chars().count())).into(),
                menu_detail(*item, app).dim(),
            ]))
        })
        .collect();

    frame.render_stateful_widget(
        List::new(items).block(
            Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(ratatui::style::Style::new().dim())
                .padding(Padding::new(2, 2, 1, 1)),
        ),
        area,
        &mut app.list_state,
    );
}

/// The right-hand column on the menu — what each choice currently holds.
///
/// Live counts rather than static blurbs. "Models" telling you there are 142
/// across 21 providers is the reason to open it; "browse available models" is
/// not.
fn menu_detail(item: MenuItem, app: &App) -> String {
    match item {
        // Says exactly what pressing Enter will do, including anything picked
        // from the lists below it. Without this the staged choices would be
        // invisible and the user would have no way to tell whether their click
        // registered.
        MenuItem::Dispatch => {
            let mut parts: Vec<String> = Vec::new();
            if let Some(path) = &app.workspace {
                parts.push(format!("into {}", project_name(path)));
            }
            if let Some(model) = &app.chosen_model {
                parts.push(format!("on {}", model.display_pin()));
            }
            if let Some(thread) = &app.chosen_thread {
                parts.push(format!("continuing {}", short_id(&thread.id)));
            }
            if parts.is_empty() {
                "send work to Aurora".to_string()
            } else {
                parts.join(", ")
            }
        }
        MenuItem::Models => match &app.catalog {
            Some(catalog) => {
                let providers: std::collections::BTreeSet<&str> = catalog
                    .entries
                    .iter()
                    .map(|entry| entry.provider_id.as_str())
                    .collect();
                format!(
                    "{} across {} providers",
                    catalog.entries.len(),
                    providers.len()
                )
            }
            None => app
                .catalog_error
                .clone()
                .unwrap_or_else(|| "unavailable".to_string()),
        },
        MenuItem::Threads => match app.threads.len() {
            0 => "none in this project".to_string(),
            1 => "1 in this project".to_string(),
            count => format!("{count} in this project"),
        },
        MenuItem::Tasks => {
            let running = app
                .tasks
                .iter()
                .filter(|task| task.status == "running" || task.status == "queued")
                .count();
            match (app.tasks.len(), running) {
                (0, _) => "none dispatched".to_string(),
                (_, 0) => format!("{} finished", app.tasks.len()),
                (_, active) => format!("{active} running"),
            }
        }
        MenuItem::Quit => String::new(),
    }
}

fn draw_models(frame: &mut Frame, area: Rect, app: &mut App) {
    let models = app.models().to_vec();
    let models = models.as_slice();
    let chosen = app.chosen_model.as_ref().map(|entry| entry.pin());
    if models.is_empty() {
        return draw_empty(
            frame,
            area,
            "Models",
            app.catalog_error
                .as_deref()
                .unwrap_or("No models configured. Add a provider in Aurora's settings."),
        );
    }

    let rows: Vec<ListItem> = models
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let selected = index == app.cursor;
            let mut spans = vec![
                if selected { "❯ " } else { "  " }.cyan(),
                // The provider's NAME: its id may be a UUID, which identifies
                // nothing to a reader.
                format!("{:<24}", truncate(entry.provider_label(), 24)).blue(),
                Span::from(format!("{:<28}", truncate(entry.display_name(), 28))),
                format!("{:>8}", context_of(entry.context_window)).dim(),
            ];
            if chosen.as_deref() == Some(entry.pin().as_str()) {
                // What THIS session will dispatch with — outranks the note
                // below, which is only what the window happens to have open.
                spans.push("  ← chosen".yellow());
            } else if entry.selected {
                spans.push("  ← in use".green());
            }
            let line = Line::from(spans);
            ListItem::new(if selected { line.bold() } else { line })
        })
        .collect();

    frame.render_stateful_widget(
        List::new(rows).block(titled("Models")),
        area,
        &mut app.list_state,
    );
}

fn draw_threads(frame: &mut Frame, area: Rect, app: &mut App) {
    let chosen = app.chosen_thread.as_ref().map(|summary| summary.id.clone());
    if app.threads.is_empty() {
        return draw_empty(
            frame,
            area,
            "Conversations",
            "No conversations in this project yet.",
        );
    }

    let cursor = app.cursor;
    let rows: Vec<ListItem> = app
        .threads
        .iter()
        .enumerate()
        .map(|(index, summary)| {
            let selected = index == cursor;
            let mut spans = vec![
                if selected { "❯ " } else { "  " }.cyan(),
                format!("{:<10}", short_id(&summary.id)).blue(),
                format!("{:>5}  ", summary.message_count).dim(),
                Span::from(truncate(&display_title(summary), 52)),
            ];
            if chosen.as_deref() == Some(summary.id.as_str()) {
                spans.push("  ← chosen".yellow());
            }
            let line = Line::from(spans);
            ListItem::new(if selected { line.bold() } else { line })
        })
        .collect();

    frame.render_stateful_widget(
        List::new(rows).block(titled("Conversations")),
        area,
        &mut app.list_state,
    );
}

fn draw_tasks(frame: &mut Frame, area: Rect, app: &mut App) {
    if app.tasks.is_empty() {
        return draw_empty(
            frame,
            area,
            "Tasks",
            "Nothing dispatched yet. Try: aurora agent \"what you want done\"",
        );
    }

    let cursor = app.cursor;
    let rows: Vec<ListItem> = app
        .tasks
        .iter()
        .enumerate()
        .map(|(index, task)| {
            let selected = index == cursor;
            let status = match task.status {
                "done" => task.status.green(),
                "failed" => task.status.red(),
                "stopped" => task.status.yellow(),
                "running" => task.status.cyan(),
                _ => task.status.dim(),
            };
            let line = Line::from(vec![
                if selected { "❯ " } else { "  " }.cyan(),
                format!("{:<24}", task.id).blue(),
                format!("{:<9}", "").into(),
                status,
                format!("  {:<14}", truncate(&project_name(&task.workspace_path), 14)).dim(),
                Span::from(truncate(&task.prompt, 40)),
            ]);
            ListItem::new(if selected { line.bold() } else { line })
        })
        .collect();

    frame.render_stateful_widget(
        List::new(rows).block(titled("Tasks")),
        area,
        &mut app.list_state,
    );
}

/// A screen with nothing on it, saying so and why.
///
/// An empty bordered box reads as a bug; a sentence explaining the state and
/// naming the next step does not.
fn draw_empty(frame: &mut Frame, area: Rect, title: &str, message: &str) {
    frame.render_widget(
        Paragraph::new(message)
            .dim()
            .alignment(Alignment::Center)
            .block(titled(title)),
        area,
    );
}

fn titled(title: &str) -> Block<'_> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(ratatui::style::Style::new().dim())
        .title(format!(" {title} "))
        .padding(Padding::new(1, 1, 0, 0))
}

/// The line above the key hints: where you are and whether Aurora is up.
fn draw_status(frame: &mut Frame, area: Rect, app: &App) {
    let mut spans: Vec<Span> = Vec::new();

    if app.aurora_running {
        spans.push(" ● ".green());
        spans.push("Aurora is running".dim());
    } else {
        spans.push(" ○ ".dim());
        spans.push("Aurora is not running — a task will start it".dim());
    }

    if let Some(entry) = app.catalog.as_ref().and_then(|c| c.selected_entry()) {
        spans.push("  ·  ".dim());
        spans.push(entry.display_pin().blue());
    }

    if let Some(workspace) = &app.workspace {
        spans.push("  ·  ".dim());
        spans.push(project_name(workspace).dim());
    }

    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// The key hints, which change with the screen so they are never a lie.
fn draw_help(frame: &mut Frame, area: Rect, app: &App) {
    let mut spans = vec![
        " ↑↓ ".bold().cyan(),
        "move  ".dim(),
    ];
    // The Enter verb names what will actually happen on THIS screen. A generic
    // "select" is why a list can look inert: it promises nothing, so nothing
    // appearing to happen reads as broken.
    let verb = match app.screen {
        Screen::Home => "open",
        Screen::Models => "use this model",
        Screen::Threads => "continue this chat",
        Screen::Tasks => "watch",
    };
    spans.push(" ⏎/click ".bold().cyan());
    spans.push(format!("{verb}  ").dim());

    if app.screen == Screen::Home {
        spans.push(" q ".bold().cyan());
        spans.push("quit".dim());
    } else {
        spans.push(" esc ".bold().cyan());
        spans.push("back  ".dim());
        if app.screen == Screen::Tasks {
            spans.push(" r ".bold().cyan());
            spans.push("refresh  ".dim());
        }
        spans.push(" ctrl-c ".bold().cyan());
        spans.push("quit".dim());
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

/// Cut a string to `max` display columns, marking the cut.
///
/// Character count, not byte length: slicing bytes panics mid-codepoint, and
/// model labels and conversation titles are exactly where non-ASCII appears.
fn truncate(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// The last path segment — enough to say which project without a column of
/// absolute path.
fn project_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// A context window as a person says it.
fn context_of(tokens: Option<i64>) -> String {
    match tokens {
        None => "—".to_string(),
        Some(value) if value >= 1_000_000 => {
            let millions = value as f64 / 1_000_000.0;
            if (millions - millions.round()).abs() < 0.05 {
                format!("{}M", millions.round() as i64)
            } else {
                format!("{millions:.1}M")
            }
        }
        Some(value) if value >= 1_000 => format!("{}k", value / 1_000),
        Some(value) => value.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn app() -> App {
        App {
            screen: Screen::Home,
            cursor: 0,
            should_quit: false,
            exit: super::super::Exit::Done,
            workspace: Some(r"E:\PayNu-Social\paynu_app".to_string()),
            catalog: None,
            threads: Vec::new(),
            tasks: Vec::new(),
            aurora_running: true,
            catalog_error: None,
            last_refresh: std::time::Instant::now(),
            chosen_model: None,
            chosen_thread: None,
            list_state: ratatui::widgets::ListState::default().with_selected(Some(0)),
        }
    }

    /// Render into an off-screen buffer and return it as text.
    ///
    /// Takes the app by value so a test can hand over a fixture without
    /// juggling mutability — rendering writes back a scroll offset, which is
    /// exactly what makes the lists scroll.
    fn render(app: &App, width: u16, height: u16) -> String {
        let mut app = App {
            list_state: app.list_state.clone(),
            catalog: app.catalog.clone(),
            threads: app.threads.clone(),
            tasks: app.tasks.clone(),
            chosen_model: app.chosen_model.clone(),
            chosen_thread: app.chosen_thread.clone(),
            workspace: app.workspace.clone(),
            catalog_error: app.catalog_error.clone(),
            screen: app.screen,
            cursor: app.cursor,
            should_quit: app.should_quit,
            exit: app.exit.clone(),
            aurora_running: app.aurora_running,
            last_refresh: app.last_refresh,
        };
        app.list_state.select(Some(app.cursor));

        let backend = TestBackend::new(width, height);
        let mut terminal = Terminal::new(backend).expect("terminal");
        terminal.draw(|frame| draw(frame, &mut app)).expect("draw");
        let buffer = terminal.backend().buffer().clone();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer[(x, y)].symbol().to_string())
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_home_screen_shows_the_logo_and_every_menu_item() {
        let rendered = render(&app(), 90, 28);
        // The logo's distinctive block row.
        assert!(rendered.contains("█████╗"), "no logo:\n{rendered}");
        for item in MenuItem::ALL {
            assert!(
                rendered.contains(item.label()),
                "menu item {:?} missing:\n{rendered}",
                item
            );
        }
    }

    #[test]
    fn a_short_terminal_drops_the_logo_but_keeps_the_menu() {
        // The logo is decoration; the app has to stay usable without it.
        let rendered = render(&app(), 90, 14);
        assert!(!rendered.contains("█████╗"));
        assert!(rendered.contains("AURORA"));
        assert!(rendered.contains("Dispatch a task"));
    }

    #[test]
    fn a_narrow_terminal_drops_the_logo() {
        // A wrapped logo is worse than none.
        let rendered = render(&app(), 40, 28);
        assert!(!rendered.contains("█████╗"));
        assert!(rendered.contains("AURORA"));
    }

    #[test]
    fn a_tiny_terminal_says_so_instead_of_scrambling() {
        let rendered = render(&app(), 20, 5);
        assert!(rendered.contains("too small"), "got:\n{rendered}");
    }

    #[test]
    fn the_selected_row_is_marked() {
        let mut app = app();
        app.cursor = 2;
        let rendered = render(&app, 90, 28);
        let marked: Vec<&str> = rendered
            .lines()
            .filter(|line| line.contains('❯'))
            .collect();
        assert_eq!(marked.len(), 1, "exactly one row should be marked");
        assert!(marked[0].contains(MenuItem::ALL[2].label()));
    }

    #[test]
    fn the_status_line_reports_whether_aurora_is_up() {
        let mut app = app();
        assert!(render(&app, 90, 28).contains("Aurora is running"));
        app.aurora_running = false;
        assert!(render(&app, 90, 28).contains("not running"));
    }

    #[test]
    fn an_empty_list_explains_itself() {
        // A blank bordered box reads as a bug.
        let mut app = app();
        app.screen = Screen::Threads;
        let rendered = render(&app, 90, 28);
        assert!(rendered.contains("No conversations"), "got:\n{rendered}");
    }

    #[test]
    fn empty_tasks_name_the_command_that_creates_one() {
        let mut app = app();
        app.screen = Screen::Tasks;
        assert!(render(&app, 90, 28).contains("aurora agent"));
    }

    #[test]
    fn help_hints_change_with_the_screen() {
        // A hint that names a key the screen does not honour is a lie.
        let mut app = app();
        assert!(render(&app, 90, 28).contains("open"));
        app.screen = Screen::Models;
        let rendered = render(&app, 90, 28);
        assert!(rendered.contains("back"));
        assert!(!rendered.contains("open"));
    }

    #[test]
    fn drawing_never_panics_at_any_size() {
        // Layout hands out zero-height regions as a terminal shrinks; every
        // widget has to survive it.
        let app = app();
        for width in [1u16, 10, 30, 40, 80, 200] {
            for height in [1u16, 3, 8, 14, 28, 60] {
                let _ = render(&app, width, height);
            }
        }
    }

    // ── mouse hit-testing ───────────────────────────────────────────────
    //
    // These assert against the SAME layout `draw` uses, so a change to the
    // header height or the block padding cannot move the rows out from under
    // the pointer without a test noticing.

    #[test]
    fn a_click_on_a_menu_row_finds_that_row() {
        let area = Rect::new(0, 0, 90, 28);
        // Home: header is the full logo (8), body starts at y=8, its border is
        // y=8, one line of top padding at y=9, so the first item is y=10.
        assert_eq!(row_at(area, Screen::Home, 20, 10), Some(0));
        assert_eq!(row_at(area, Screen::Home, 20, 11), Some(1));
        assert_eq!(row_at(area, Screen::Home, 20, 14), Some(4));
    }

    #[test]
    fn the_hit_test_agrees_with_what_was_drawn() {
        // The real guarantee: whatever row the renderer marked as selected is
        // the row a click at that line reports. Anything else means the
        // pointer and the highlight disagree.
        let area = Rect::new(0, 0, 90, 28);
        for index in 0..MenuItem::ALL.len() {
            let mut app = app();
            app.cursor = index;
            let rendered = render(&app, area.width, area.height);
            let marked_line = rendered
                .lines()
                .position(|line| line.contains('❯'))
                .expect("a row is always marked");
            assert_eq!(
                row_at(area, Screen::Home, 20, marked_line as u16),
                Some(index),
                "row {index} draws on line {marked_line} but hit-tests elsewhere"
            );
        }
    }

    #[test]
    fn a_list_screen_has_no_top_padding() {
        // The list blocks start immediately under their border, unlike the
        // menu; getting this wrong offsets every click by one row.
        let area = Rect::new(0, 0, 90, 28);
        assert_eq!(row_at(area, Screen::Models, 20, 9), Some(0));
    }

    #[test]
    fn clicks_outside_the_list_hit_nothing() {
        let area = Rect::new(0, 0, 90, 28);
        // The logo.
        assert_eq!(row_at(area, Screen::Home, 20, 2), None);
        // The block's own border row.
        assert_eq!(row_at(area, Screen::Home, 20, 8), None);
        // The status and help lines at the bottom.
        assert_eq!(row_at(area, Screen::Home, 20, 26), None);
        assert_eq!(row_at(area, Screen::Home, 20, 27), None);
        // Left and right of the block.
        assert_eq!(row_at(area, Screen::Home, 0, 10), None);
        assert_eq!(row_at(area, Screen::Home, 89, 10), None);
    }

    #[test]
    fn the_hit_test_follows_the_header_shrinking() {
        // A short terminal drops the logo, moving every row up. A cached
        // layout would send clicks to the wrong item after a resize.
        let tall = Rect::new(0, 0, 90, 28);
        let short = Rect::new(0, 0, 90, 14);
        assert_eq!(row_at(tall, Screen::Home, 20, 10), Some(0));
        // Header is 2 lines here, so body starts at y=2 and the first item is
        // at y=4.
        assert_eq!(row_at(short, Screen::Home, 20, 4), Some(0));
    }

    #[test]
    fn a_terminal_too_small_hit_tests_nothing() {
        // There is no list drawn, so there is nothing to click.
        assert_eq!(row_at(Rect::new(0, 0, 20, 5), Screen::Home, 5, 3), None);
    }

    #[test]
    fn the_help_line_advertises_the_mouse() {
        // A menu that is clickable but does not say so is not discoverable;
        // one that looks clickable and is not reads as broken.
        assert!(render(&app(), 90, 28).contains("click"));
    }

    #[test]
    fn truncation_marks_the_cut_and_respects_codepoints() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("abcdefghij", 5), "abcd…");
        // A multi-byte string is the case a byte-slice would panic on.
        let wide = "あいうえおかきくけこ";
        let cut = truncate(wide, 4);
        assert_eq!(cut.chars().count(), 4);
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn context_windows_read_naturally() {
        assert_eq!(context_of(None), "—");
        assert_eq!(context_of(Some(128_000)), "128k");
        assert_eq!(context_of(Some(1_000_000)), "1M");
        assert_eq!(context_of(Some(1_500_000)), "1.5M");
    }
}
