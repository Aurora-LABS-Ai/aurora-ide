//! Terminal presentation for the `aurora` CLI — the palette, the glyph
//! vocabulary, and the one decision every print site depends on: whether
//! anything is allowed to be styled at all.
//!
//! Styling itself is [`crossterm`]'s. What lives here is the layer above it:
//! *roles* rather than colours, so a call site says "this failed" and this
//! module decides what failure looks like. Changing a hue is then one edit
//! here instead of a sweep through every `println!` in the module.
//!
//! ## Colour is off unless it has somewhere to go
//!
//! Four gates, any one of which disables styling:
//!
//! 1. `--color never` ([`ColorChoice::Never`]).
//! 2. `NO_COLOR` set to anything — presence alone is the signal, per the
//!    informal standard — or `TERM=dumb`.
//! 3. stdout is not a terminal.
//! 4. The terminal is a Windows console too old to interpret ANSI, which
//!    [`crossterm::ansi_support`] answers by actually trying to enable
//!    virtual-terminal processing rather than guessing from the OS version.
//!
//! Gate 3 is the load-bearing one. The point of `aurora agent --out run.jsonl`
//! is that *another program* reads the result — a second agent, a CI step, a
//! `tail -f` in the next pane. Escape codes in that stream are corruption, not
//! decoration. So a redirected stdout is plain text, always, and the styled
//! form exists only while a human is looking at it.
//!
//! `--color always` overrides gates 2–4, for the case where a human is
//! watching through a pipe (`aurora … | less -R`).

use std::io::IsTerminal;

use crossterm::style::{Attribute, Color, Stylize};

/// Whether the caller wants ANSI styling.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ColorChoice {
    /// Style only when stdout is a terminal that can render it.
    #[default]
    Auto,
    /// Never emit escape codes.
    Never,
    /// Emit escape codes even when stdout is redirected.
    Always,
}

impl ColorChoice {
    /// Resolve the choice against the actual environment.
    fn enabled(self) -> bool {
        match self {
            ColorChoice::Never => false,
            ColorChoice::Always => true,
            ColorChoice::Auto => {
                if std::env::var_os("NO_COLOR").is_some() {
                    return false;
                }
                if std::env::var("TERM").is_ok_and(|term| term == "dumb") {
                    return false;
                }
                if !std::io::stdout().is_terminal() {
                    return false;
                }
                // On Windows this attempts to switch the console into
                // virtual-terminal mode and reports whether it took; on every
                // other platform it is a constant `true`. Either way it beats
                // inferring support from `TERM`.
                crossterm::style::available_color_count() > 0
            }
        }
    }
}

/// One semantic role in the CLI's palette.
///
/// These map to the terminal's *named* colours rather than to RGB triples, on
/// purpose. The named sixteen are the ones a user's own terminal theme
/// remaps — so someone on a light background gets their blue, which stays
/// legible against their paper, instead of a hue chosen against a dark
/// terminal that turns to mud on theirs.
///
/// [`Style::Brand`] is the single exception and says why inline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Style {
    /// Aurora's own mark and section headings.
    ///
    /// The one fixed colour in the palette. Aurora's icon is a gold chevron on
    /// charcoal (`src-tauri/icons/icon.png`), so the mark is gold — a brand
    /// colour that changes hue with the user's terminal theme is not a brand
    /// colour. Everything else in this enum defers to their theme.
    Brand,
    /// Body text. Deliberately unstyled so it inherits the terminal's own
    /// foreground — wrapping it in a reset would clear any surrounding style
    /// rather than sit inside it.
    Text,
    /// Secondary detail: counts, ids, elapsed times, paths already implied by
    /// context. Dimmed, never coloured — this text needs to recede, and a hue
    /// pulls the eye instead of releasing it.
    Muted,
    /// A finished thing that worked.
    Success,
    /// A finished thing that did not.
    Error,
    /// Something that wants attention but did not fail.
    Warning,
    /// A live, still-running thing.
    Active,
    /// Something the user can act on next — a thread id to pass to
    /// `--continue`, a command to copy.
    Hint,
}

/// Glyph vocabulary, as `(unicode, ascii)` pairs.
///
/// The ASCII half is not decoration. Aurora ships on Windows first, where a
/// console still on a legacy code page renders an unmapped codepoint as `?`
/// or a filled box. A row that degrades to `*` stays readable; a row of
/// mojibake does not. [`Term::g`] picks the half that will actually render.
pub mod glyph {
    /// Row marker for an event — a tool starting, a message arriving.
    ///
    /// The reference CLI (`thirdparty/claude-code-cli/src/constants/figures.ts`)
    /// uses `⏺` on macOS and `●` everywhere else; `●` is the portable half of
    /// that pair, and the one Windows renders without a font hunt.
    pub const DOT: (&str, &str) = ("●", "*");
    /// Continuation marker: the result belonging to the row above.
    pub const ELBOW: (&str, &str) = ("⎿", "\\_");
    /// Aurora is working.
    pub const SPARK: (&str, &str) = ("✻", "*");
    pub const CHECK: (&str, &str) = ("✓", "ok");
    pub const CROSS: (&str, &str) = ("✗", "x");
    pub const WARN: (&str, &str) = ("⚠", "!");
    /// Marks the selected row in a list.
    pub const POINTER: (&str, &str) = ("❯", ">");
    /// Field separator inside one line.
    pub const MIDDOT: (&str, &str) = ("·", "-");
    pub const ARROW: (&str, &str) = ("→", "->");
    /// Vertical rule for a nested/indented block.
    pub const PIPE: (&str, &str) = ("│", "|");
}

/// The resolved output style for one CLI invocation.
///
/// Built once at startup and threaded down, so "is colour on" is answered a
/// single time rather than re-derived — and possibly re-answered differently —
/// at each print site.
#[derive(Debug, Clone, Copy)]
pub struct Term {
    color: bool,
    unicode: bool,
}

impl Term {
    /// Resolve styling for this process.
    pub fn new(choice: ColorChoice) -> Self {
        Self {
            color: choice.enabled(),
            unicode: unicode_ok(),
        }
    }

    /// A plain-text terminal: no colour, no unicode. What a redirected stream
    /// and the `--out` transcript get.
    pub fn plain() -> Self {
        Self {
            color: false,
            unicode: false,
        }
    }

    /// Whether ANSI styling is active.
    pub fn color(&self) -> bool {
        self.color
    }

    /// Whether non-ASCII glyphs are safe to emit.
    pub fn unicode(&self) -> bool {
        self.unicode
    }

    /// Pick the renderable half of a [`glyph`] pair.
    pub fn g(&self, glyph: (&'static str, &'static str)) -> &'static str {
        if self.unicode {
            glyph.0
        } else {
            glyph.1
        }
    }

    /// Render `text` in `style`, or untouched when colour is off.
    pub fn paint(&self, style: Style, text: &str) -> String {
        if !self.color || style == Style::Text {
            return text.to_string();
        }
        match style {
            // `Muted` is an attribute, not a colour — dimming keeps whatever
            // hue the surrounding context established instead of overriding it.
            Style::Muted => text.attribute(Attribute::Dim).to_string(),
            Style::Text => text.to_string(),
            other => text.with(color_of(other)).to_string(),
        }
    }

    /// Bold `text`. Kept off [`Style`] because emphasis composes with a role
    /// rather than replacing it — a bold error is still an error.
    pub fn bold(&self, text: &str) -> String {
        if !self.color {
            return text.to_string();
        }
        text.attribute(Attribute::Bold).to_string()
    }

    /// Bold *and* coloured, as one sequence rather than two that each reset.
    pub fn strong(&self, style: Style, text: &str) -> String {
        if !self.color {
            return text.to_string();
        }
        match style {
            Style::Text => self.bold(text),
            Style::Muted => text.attribute(Attribute::Dim).to_string(),
            other => text.with(color_of(other)).attribute(Attribute::Bold).to_string(),
        }
    }
}

/// The concrete colour behind a role. Private, so roles stay the vocabulary
/// and hues stay an implementation detail.
fn color_of(style: Style) -> Color {
    match style {
        // Aurora's gold, sampled from the icon's lit face. The only hardcoded
        // colour in the palette — see the note on `Style::Brand`. 256-colour
        // rather than truecolour so it still lands somewhere gold on a
        // terminal that does not do 24-bit.
        Style::Brand => Color::AnsiValue(214),
        Style::Success => Color::Green,
        Style::Error => Color::Red,
        Style::Warning => Color::Yellow,
        Style::Active => Color::Cyan,
        Style::Hint => Color::Blue,
        // Handled before this function is reached; mapped rather than
        // `unreachable!` so a future role added to the enum degrades to
        // readable text instead of aborting the CLI.
        Style::Text | Style::Muted => Color::Reset,
    }
}

/// Whether the terminal can be trusted with non-ASCII glyphs.
///
/// On Windows this is a question about the console's active output code page:
/// 65001 is UTF-8, and anything else (437, 850, 1252 …) cannot represent `●`
/// or `⎿` at all. On Unix it is a question about the locale.
fn unicode_ok() -> bool {
    #[cfg(windows)]
    {
        // `GetConsoleOutputCP` via crossterm's already-linked winapi surface
        // would be ideal, but it is not re-exported; the locale check below is
        // meaningless on Windows, so read the code page through the console
        // crate's own answer instead: crossterm sets the process to UTF-8 when
        // it enables VT, so an ANSI-capable console is a UTF-8 one.
        crossterm::ansi_support::supports_ansi()
    }
    #[cfg(not(windows))]
    {
        // A UTF-8 locale in any of the three variables the C library consults.
        ["LC_ALL", "LC_CTYPE", "LANG"].iter().any(|key| {
            std::env::var(key).is_ok_and(|value| {
                let value = value.to_ascii_uppercase();
                value.contains("UTF-8") || value.contains("UTF8")
            })
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Styling forced on, so the assertions describe the renderer rather than
    /// the machine the suite happens to run on.
    fn styled() -> Term {
        Term {
            color: true,
            unicode: true,
        }
    }

    fn unstyled() -> Term {
        Term {
            color: false,
            unicode: false,
        }
    }

    #[test]
    fn colour_off_emits_no_escapes() {
        let term = unstyled();
        assert_eq!(term.paint(Style::Error, "boom"), "boom");
        assert_eq!(term.bold("boom"), "boom");
        assert_eq!(term.strong(Style::Error, "boom"), "boom");
    }

    #[test]
    fn painted_text_carries_a_reset() {
        // The exact escape bytes are crossterm's business; what this pins is
        // that styling both applies AND terminates, since an unterminated SGR
        // bleeds into the rest of the user's terminal session long after the
        // command exits.
        //
        // Two accepted terminators, because crossterm picks per style: a
        // colour closes with SGR 39 (default foreground) and an attribute with
        // SGR 0 (reset all). Both end the span; asserting one specific code
        // would be pinning crossterm's internals rather than our invariant.
        for style in [Style::Error, Style::Muted, Style::Brand] {
            let painted = styled().paint(style, "boom");
            assert!(painted.contains("boom"), "{style:?} dropped its text");
            assert!(painted.starts_with('\x1b'), "{style:?} was not styled");
            assert!(
                painted.ends_with("\x1b[0m") || painted.ends_with("\x1b[39m"),
                "{style:?} left the style open: {painted:?}"
            );
        }
    }

    #[test]
    fn strong_applies_both_weight_and_hue() {
        let painted = styled().strong(Style::Error, "boom");
        assert!(painted.contains("boom"));
        // SGR 1 is bold; its presence alongside a colour introducer is what
        // separates `strong` from `paint`.
        assert!(painted.contains("\x1b[1m"), "not bold: {painted:?}");
        assert!(painted.starts_with('\x1b'));
    }

    #[test]
    fn body_text_is_never_wrapped() {
        // `Style::Text` means "the terminal's own foreground". Wrapping it
        // would reset any surrounding style instead of inheriting it.
        assert_eq!(styled().paint(Style::Text, "hello"), "hello");
    }

    #[test]
    fn glyphs_fall_back_to_ascii() {
        assert_eq!(styled().g(glyph::DOT), "●");
        assert_eq!(unstyled().g(glyph::DOT), "*");
        assert_eq!(unstyled().g(glyph::ELBOW), "\\_");
    }

    #[test]
    fn never_and_always_ignore_the_environment() {
        assert!(!ColorChoice::Never.enabled());
        assert!(ColorChoice::Always.enabled());
    }

    #[test]
    fn no_color_env_disables_auto() {
        // `NO_COLOR` is process-global and this suite runs threaded, so the
        // variable is restored before the test returns.
        let restore = std::env::var_os("NO_COLOR");
        std::env::set_var("NO_COLOR", "1");
        assert!(!ColorChoice::Auto.enabled());
        // An explicit `--color always` still outranks it.
        assert!(ColorChoice::Always.enabled());
        match restore {
            Some(value) => std::env::set_var("NO_COLOR", value),
            None => std::env::remove_var("NO_COLOR"),
        }
    }
}
