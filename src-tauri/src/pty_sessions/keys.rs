//! Named keys, as the bytes a terminal sends for them.
//!
//! Arrow-key menus (inquirer, questionary, `npm init`-style pickers) do not
//! read `1`; they read ↓ ↓ Enter. A model can name those keys but cannot
//! reliably type the escape sequences, so the tool takes names.

/// The bytes for one key name, or `None` for a name this does not know.
/// Names are case-insensitive; `ctrl+x` covers the control letters.
#[must_use]
pub fn bytes(name: &str) -> Option<Vec<u8>> {
    let key = name.trim().to_ascii_lowercase();
    let fixed: &[u8] = match key.as_str() {
        "enter" | "return" => b"\r",
        "tab" => b"\t",
        "shift+tab" | "backtab" => b"\x1b[Z",
        "esc" | "escape" => b"\x1b",
        "backspace" => b"\x7f",
        "delete" | "del" => b"\x1b[3~",
        "space" => b" ",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "right" => b"\x1b[C",
        "left" => b"\x1b[D",
        "home" => b"\x1b[H",
        "end" => b"\x1b[F",
        "pageup" | "page_up" => b"\x1b[5~",
        "pagedown" | "page_down" => b"\x1b[6~",
        _ => {
            let letter = key.strip_prefix("ctrl+").or_else(|| key.strip_prefix("ctrl-"))?;
            let mut chars = letter.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else {
                return None;
            };
            if !c.is_ascii_lowercase() {
                return None;
            }
            return Some(vec![c as u8 - b'a' + 1]);
        }
    };
    Some(fixed.to_vec())
}

/// Every name [`bytes`] accepts, for the error that names the right ones.
pub const NAMES: &str = "enter, tab, shift+tab, esc, backspace, delete, space, up, down, left, \
                         right, home, end, pageup, pagedown, ctrl+a … ctrl+z";

#[cfg(test)]
mod tests {
    use super::bytes;

    #[test]
    fn menus_and_control_keys_map_to_terminal_bytes() {
        assert_eq!(bytes("Down").unwrap(), b"\x1b[B");
        assert_eq!(bytes("enter").unwrap(), b"\r");
        assert_eq!(bytes("ctrl+c").unwrap(), vec![3]);
        assert_eq!(bytes("ctrl+z").unwrap(), vec![26]);
        assert!(bytes("ctrl+").is_none());
        assert!(bytes("hyper").is_none());
    }
}
