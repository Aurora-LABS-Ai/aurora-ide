/**
 * Angle brackets in an answer are text, not markup.
 *
 * Streamdown turns raw HTML into real elements by default. An agent that talks
 * about code writes `<T>`, `<your-key>`, `<Component />` and Aurora's own
 * `<repo_map>`-style tags in ordinary prose, and every one of them was being
 * parsed as a tag. Unknown tags render as nothing, so the words simply
 * disappeared from the reply — React logged a warning in the console and the
 * reader saw a sentence with a hole in it.
 *
 * These render the real component. Asserting on the text a person would see is
 * the only check that catches this, because nothing throws when it breaks.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentMarkdown } from "./AgentMarkdown";

describe("AgentMarkdown", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  const render = (content: string) => {
    act(() => {
      root = createRoot(container);
      root.render(<AgentMarkdown content={content} />);
    });
    return container.textContent ?? "";
  };

  it("shows a tag-shaped word instead of swallowing it", () => {
    // The exact report: `<date>` vanished and React warned about an
    // unrecognized tag.
    expect(render("Use the <date> field for that.")).toContain("<date>");
  });

  it("keeps the tags an agent writes when it talks about code", () => {
    const text = render("Pass <your-key> to the client, and type it as <T>.");
    expect(text).toContain("<your-key>");
    expect(text).toContain("<T>");
  });

  it("keeps Aurora's own context tags readable when the model repeats one", () => {
    expect(render("I read the <repo_map> block first.")).toContain("<repo_map>");
  });

  it("still renders ordinary markdown", () => {
    // The guard that the fix changed only what it meant to. Bold is checked
    // through Streamdown's own marker rather than a `<strong>` tag, because it
    // renders emphasis as a styled span.
    const text = render("A **bold** word and `some code`.");
    expect(text).toContain("bold");
    expect(text).toContain("some code");
    expect(container.querySelector('[data-streamdown="strong"]')).not.toBeNull();
    expect(container.querySelector("code")).not.toBeNull();
  });
});
