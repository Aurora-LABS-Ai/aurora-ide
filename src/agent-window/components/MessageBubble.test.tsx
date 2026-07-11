import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessageBubble } from "./MessageBubble";

describe("MessageBubble prompt chips", () => {
  it("replays file paths with spaces and slash commands as composer pills", () => {
    const html = renderToStaticMarkup(
      <MessageBubble
        showActions={false}
        message={{
          role: "user",
          content: "Review @src/brand values.tsx",
          attachedPromptChips: [
            {
              kind: "file",
              title: "brand values.tsx",
              value: "src/brand values.tsx",
              path: "E:/work/src/brand values.tsx",
            },
            { kind: "skill", title: "frontend-design" },
          ],
        }}
      />,
    );

    expect(html).toContain("agw-pill-inline");
    expect(html).toContain("agw-pill-cmd");
    expect(html).toContain("brand values.tsx");
    expect(html).toContain("frontend-design");
    expect(html).not.toContain("@src/brand values.tsx");
  });
});
