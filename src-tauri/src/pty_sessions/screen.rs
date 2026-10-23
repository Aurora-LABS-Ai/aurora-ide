//! A terminal's screen as text for the agent.
//!
//! The vt100 parser has already applied every escape code — colours, cursor
//! moves, a progress bar redrawn in place — so what comes out is what a person
//! sees. Two things are added for a reader that cannot see colour: a line drawn
//! in inverse video (the highlighted choice in an arrow-key menu) is marked
//! `▶ `, and a full-screen program (alternate screen) is read as its visible
//! screen, since its scrollback is not what it is showing.

use serde::Serialize;

/// Which part of the output to read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scope {
    /// Everything: scrollback and screen.
    All,
    /// From this line of the combined scrollback + screen onward.
    From(usize),
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Read {
    pub text: String,
    /// Lines in the range read, before the head/tail cut.
    pub total_lines: usize,
    pub hidden_lines: usize,
    /// A full-screen program is showing; `text` is its screen.
    pub full_screen: bool,
}

/// Lines of scrollback + screen, each with whether it is highlighted.
pub fn lines(parser: &mut vt100::Parser) -> Vec<String> {
    let (rows, cols) = {
        let (rows, cols) = parser.screen().size();
        (usize::from(rows.get()), cols.get())
    };
    let screen = parser.screen_mut();
    if screen.alternate_screen() {
        return visible(screen, cols);
    }
    let total = screen.scrollback_len();
    let mut out = Vec::with_capacity(total + rows);
    let mut start = 0usize;
    while start < total + rows {
        let offset = total.saturating_sub(start);
        screen.set_scrollback(offset);
        let view_top = total - screen.scrollback();
        for (index, line) in visible(screen, cols).into_iter().enumerate() {
            if view_top + index >= start {
                out.push(line);
            }
        }
        start = view_top + rows;
    }
    screen.set_scrollback(0);
    out
}

fn visible(screen: &vt100::Screen, cols: u16) -> Vec<String> {
    screen
        .rows(0, cols)
        .enumerate()
        .map(|(row, text)| {
            let text = text.trim_end().to_string();
            if highlighted(screen, row as u16, cols) {
                format!("▶ {text}")
            } else {
                text
            }
        })
        .collect()
}

/// Most of the row's written cells are inverse video.
fn highlighted(screen: &vt100::Screen, row: u16, cols: u16) -> bool {
    let (mut written, mut inverse) = (0usize, 0usize);
    for col in 0..cols {
        let Some(cell) = screen.cell(row, col) else {
            break;
        };
        if cell.has_contents() && !cell.contents().trim().is_empty() {
            written += 1;
            if cell.inverse() {
                inverse += 1;
            }
        }
    }
    written > 0 && inverse * 2 >= written
}

/// Read a range, keeping `head` lines from its start and `tail` from its end.
///
/// Both ends, because a compiler prints the real error first and "could not
/// compile" last. The gap is stated in the text: two fragments joined without
/// a marker read as consecutive output.
pub fn read(parser: &mut vt100::Parser, scope: Scope, head: usize, tail: usize) -> Read {
    let full_screen = parser.screen().alternate_screen();
    let mut all = lines(parser);
    while all.last().is_some_and(String::is_empty) {
        all.pop();
    }
    let start = match scope {
        Scope::From(line) if !full_screen => line.min(all.len().saturating_sub(1)),
        _ => 0,
    };
    let mut range: Vec<String> = all.split_off(start.min(all.len()));
    while range.first().is_some_and(String::is_empty) {
        range.remove(0);
    }
    let total_lines = range.len();
    let mut hidden_lines = 0;
    if range.len() > head + tail {
        hidden_lines = range.len() - head - tail;
        let end = range.split_off(range.len() - tail);
        range.truncate(head);
        range.push(format!("… {hidden_lines} lines hidden …"));
        range.extend(end);
    }
    Read {
        text: range.join("\n"),
        total_lines,
        hidden_lines,
        full_screen,
    }
}

/// The combined line index where the next output will start: the cursor's line.
pub fn cursor_line(parser: &vt100::Parser) -> usize {
    let screen = parser.screen();
    screen.scrollback_len() + usize::from(screen.cursor_position().0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU16;

    fn parser(rows: u16, cols: u16) -> vt100::Parser {
        vt100::Parser::new(
            NonZeroU16::new(rows).unwrap(),
            NonZeroU16::new(cols).unwrap(),
            1000,
        )
    }

    #[test]
    fn colours_and_redraws_come_out_as_the_text_on_screen() {
        let mut p = parser(5, 40);
        p.process(b"\x1b[32mok\x1b[0m line\r\nprogress 10%\rprogress 100%\r\n");
        let read = read(&mut p, Scope::All, 40, 40);
        assert_eq!(read.text, "ok line\nprogress 100%");
    }

    #[test]
    fn scrollback_is_read_in_order_past_the_screen_height() {
        let mut p = parser(3, 20);
        for n in 1..=10 {
            p.process(format!("line {n}\r\n").as_bytes());
        }
        let text = read(&mut p, Scope::All, 100, 100).text;
        let expected: Vec<String> = (1..=10).map(|n| format!("line {n}")).collect();
        assert_eq!(text, expected.join("\n"));
    }

    #[test]
    fn the_highlighted_menu_choice_is_marked() {
        let mut p = parser(5, 30);
        p.process(b"  Rebuild index\r\n\x1b[7m  Clear cache  \x1b[0m\r\n  Quit\r\n");
        let text = read(&mut p, Scope::All, 40, 40).text;
        assert_eq!(text, "  Rebuild index\n▶   Clear cache\n  Quit");
    }

    #[test]
    fn a_long_range_keeps_both_ends_and_says_what_it_dropped() {
        let mut p = parser(5, 20);
        for n in 1..=50 {
            p.process(format!("line {n}\r\n").as_bytes());
        }
        let read = read(&mut p, Scope::All, 2, 2);
        assert_eq!(read.text, "line 1\nline 2\n… 46 lines hidden …\nline 49\nline 50");
        assert_eq!(read.hidden_lines, 46);
    }

    #[test]
    fn reading_from_a_line_skips_what_came_before() {
        let mut p = parser(5, 20);
        p.process(b"old\r\n");
        let from = cursor_line(&p);
        p.process(b"new\r\n");
        assert_eq!(read(&mut p, Scope::From(from), 40, 40).text, "new");
    }
}
