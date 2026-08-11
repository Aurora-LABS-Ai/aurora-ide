//! A visible pointer, so a click looks like a click.
//!
//! `browser_click` calls `el.click()`. Nothing moves, nothing highlights, and
//! the page simply jumps to its new state — from the outside it is
//! indistinguishable from the page doing it by itself, and if the agent clicked
//! the WRONG element you find out from a later screenshot rather than from
//! watching it happen. So before acting, Aurora draws a cursor at the element
//! it is about to touch and plays a press ripple there.
//!
//! This is a report of what the tool did, not a decoration: the coordinates
//! come from the live bounding rect of the element that is actually about to be
//! clicked, so a pointer landing somewhere surprising IS the bug showing itself.
//!
//! ## Why it is injected, and why that is safe here
//!
//! The page is a native webview that paints above all DOM (see
//! `tools::browser::halo`), so the cursor cannot be drawn from Aurora's side —
//! it has to live in the page. Injected furniture is normally a hazard for a
//! toolset whose whole job is reporting the page accurately, so three things
//! keep it out of every answer:
//!
//! * it is appended to `document.documentElement`, while `browser_view` and
//!   `browser_page_outline` scan from `document.body` — outside the scan root
//!   entirely;
//! * it is a bare `div` with `aria-hidden`, matching neither reader's
//!   interactive/landmark selector nor the accessibility tree;
//! * it removes itself shortly after the action, and [`hide_expr`] removes it
//!   outright before any screenshot, so no capture can contain it.
//!
//! Built with `createElementNS`/`createElement` rather than `innerHTML`, and
//! styled through the CSSOM rather than a `<style>` tag, so it survives pages
//! that enforce Trusted Types or a strict `style-src`.

/// How long the cursor glides to its target before the action fires.
///
/// Long enough to read as movement, short enough to stay out of the way: it is
/// paid on every click, on top of the settle pause the action already takes.
const GLIDE_MS: u64 = 200;

/// How long the cursor lingers after the action before removing itself.
///
/// Covers the settle-and-observe tail, so the user can still see where the
/// click landed while the result comes back — and guarantees the page is clean
/// again well before any later screenshot.
const LINGER_MS: u64 = 1_400;

/// The installer, shared by every expression below.
///
/// Idempotent: a second call reuses the existing node so the cursor GLIDES
/// between targets instead of teleporting, which is what makes a sequence of
/// clicks legible as a sequence.
const INSTALL: &str = r#"
  const ID = '__aurora_agent_pointer';
  const install = () => {
    let el = document.getElementById(ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = ID;
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;left:0;top:0;width:20px;height:26px;' +
      'margin:0;padding:0;border:0;background:none;pointer-events:none;' +
      'z-index:2147483647;opacity:0;will-change:transform;' +
      'transition:transform 200ms cubic-bezier(0,0,0.2,1),opacity 120ms linear';

    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 20 26');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '26');
    svg.style.cssText = 'display:block;overflow:visible';
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M3 2 L3 20.5 L7.7 16.2 L10.6 22.8 L13.6 21.4 L10.8 15 L17 14.6 Z');
    // White body on a dark outline reads on any page, light or dark, without
    // knowing anything about the design underneath.
    arrow.setAttribute('fill', '#ffffff');
    arrow.setAttribute('stroke', 'rgba(0,0,0,0.75)');
    arrow.setAttribute('stroke-width', '1.6');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    el.appendChild(svg);
    document.documentElement.appendChild(el);
    return el;
  };
  const remove = () => {
    const el = document.getElementById(ID);
    if (el) el.remove();
  };
  const scheduleRemoval = (ms) => {
    clearTimeout(window.__auroraPointerTimer);
    window.__auroraPointerTimer = setTimeout(remove, ms);
  };
  const ripple = (x, y) => {
    const dot = document.createElement('div');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;margin:-13px 0 0 -13px;' +
      'border-radius:50%;border:2px solid rgba(255,255,255,0.95);' +
      'box-shadow:0 0 0 1.5px rgba(0,0,0,0.55);pointer-events:none;z-index:2147483646;' +
      'transform:translate(' + x + 'px,' + y + 'px) scale(0.3)';
    document.documentElement.appendChild(dot);
    // Web Animations rather than a keyframe rule: no <style> tag to inject, and
    // nothing left in the page once it finishes.
    const anim = dot.animate(
      [
        { transform: 'translate(' + x + 'px,' + y + 'px) scale(0.3)', opacity: 1 },
        { transform: 'translate(' + x + 'px,' + y + 'px) scale(1.7)', opacity: 0 }
      ],
      { duration: 420, easing: 'cubic-bezier(0,0,0.2,1)' }
    );
    anim.onfinish = () => dot.remove();
    anim.oncancel = () => dot.remove();
  };
"#;

/// Move the cursor onto the element `selector` names, optionally pressing.
///
/// Never throws. A pointer that cannot find its target must not be the reason a
/// click fails — the click itself is about to report that far more precisely,
/// and swallowing the difference here would turn a clear "no element matches"
/// into a confusing pointer error.
pub fn point_at_selector_expr(selector: &str, press: bool) -> String {
    format!(
        r#"(async () => {{
{install}
  try {{
    const el = document.querySelector({sel});
    if (!el) return {{ shown: false, reason: 'no element' }};
    // Same scroll the click is about to do, so the rect we point at is the
    // rect that gets clicked rather than the one from before the scroll.
    el.scrollIntoView({{ block: 'center', inline: 'center' }});
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) return {{ shown: false, reason: 'no box' }};
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);

    const node = install();
    const first = node.style.opacity === '0' || node.style.opacity === '';
    if (first) {{
      // Nothing to glide FROM on the first appearance — a transition from the
      // top-left corner would read as the cursor flying in from off-page.
      node.style.transition = 'opacity 120ms linear';
      node.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      void node.offsetWidth;
      node.style.transition = 'transform {glide}ms cubic-bezier(0,0,0.2,1),opacity 120ms linear';
    }} else {{
      node.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }}
    node.style.opacity = '1';

    await new Promise((done) => setTimeout(done, first ? 60 : {glide}));
    if ({press}) ripple(x, y);
    scheduleRemoval({linger});
    return {{ shown: true, x, y }};
  }} catch (e) {{
    return {{ shown: false, reason: String(e && e.message || e) }};
  }}
}})()"#,
        install = INSTALL,
        sel = serde_json::json!(selector),
        press = if press { "true" } else { "false" },
        glide = GLIDE_MS,
        linger = LINGER_MS,
    )
}

/// Move the cursor to viewport coordinates the caller already has.
///
/// `browser_hover` dispatches real pointer input at an x/y it computed itself;
/// re-deriving the point from the selector here could disagree with it, and a
/// cursor drawn somewhere other than where the pointer actually went is worse
/// than no cursor at all.
pub fn point_at_xy_expr(x: f64, y: f64, press: bool) -> String {
    format!(
        r#"(async () => {{
{install}
  try {{
    const x = {x}, y = {y};
    const node = install();
    const first = node.style.opacity === '0' || node.style.opacity === '';
    if (first) {{
      node.style.transition = 'opacity 120ms linear';
      node.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      void node.offsetWidth;
      node.style.transition = 'transform {glide}ms cubic-bezier(0,0,0.2,1),opacity 120ms linear';
    }} else {{
      node.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    }}
    node.style.opacity = '1';
    await new Promise((done) => setTimeout(done, first ? 60 : {glide}));
    if ({press}) ripple(x, y);
    scheduleRemoval({linger});
    return {{ shown: true, x, y }};
  }} catch (e) {{
    return {{ shown: false, reason: String(e && e.message || e) }};
  }}
}})()"#,
        install = INSTALL,
        x = x.round(),
        y = y.round(),
        press = if press { "true" } else { "false" },
        glide = GLIDE_MS,
        linger = LINGER_MS,
    )
}

/// Take the cursor out of the page immediately.
///
/// Called before every screenshot. The capture is a picture of the real
/// webview surface, so anything Aurora drew in the page would be photographed
/// as if the site had rendered it — and a visual audit is precisely the job
/// where an Aurora artefact must never appear.
pub fn hide_expr() -> String {
    r#"(() => {
  try {
    clearTimeout(window.__auroraPointerTimer);
    const el = document.getElementById('__aurora_agent_pointer');
    if (el) el.remove();
    return { hidden: true };
  } catch (e) {
    return { hidden: false };
  }
})()"#
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The readers scan from `document.body`; anything appended there would
    /// show up as a page element in `browser_view` and `browser_page_outline`.
    #[test]
    fn the_cursor_lives_outside_the_region_the_page_readers_scan() {
        let js = point_at_selector_expr("button", true);
        assert!(js.contains("document.documentElement.appendChild"));
        assert!(!js.contains("document.body.appendChild"));
    }

    /// A screenshot that contained Aurora's own cursor would be a fabricated
    /// picture of the user's page.
    #[test]
    fn the_cursor_can_be_removed_outright() {
        assert!(hide_expr().contains("el.remove()"));
        assert!(hide_expr().contains("clearTimeout"));
    }

    /// A selector is data, never source: a page element named `'); alert('`
    /// must reach `querySelector` as a string.
    #[test]
    fn a_selector_is_json_encoded_not_pasted_in() {
        let js = point_at_selector_expr("a[href=\"x\"]", false);
        assert!(js.contains(r#"document.querySelector("a[href=\"x\"]")"#));
    }

    /// The click is what reports failure, and it says far more than the
    /// pointer could. A throw here would replace that message with a worse one.
    #[test]
    fn a_pointer_that_cannot_find_its_target_reports_rather_than_throws() {
        let js = point_at_selector_expr("#gone", true);
        assert!(js.contains("shown: false, reason: 'no element'"));
        assert!(js.contains("catch (e)"));
    }

    /// Only a real press draws a ripple — a hover that rippled would be
    /// claiming an interaction that never happened.
    #[test]
    fn the_ripple_is_only_played_for_an_actual_press() {
        assert!(point_at_xy_expr(10.0, 20.0, true).contains("if (true) ripple"));
        assert!(point_at_xy_expr(10.0, 20.0, false).contains("if (false) ripple"));
    }
}
