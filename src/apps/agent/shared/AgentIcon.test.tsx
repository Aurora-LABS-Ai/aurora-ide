import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./AgentIcon";

describe("AgentIcon", () => {
  it("draws the filled twin only when asked and only where one exists", () => {
    expect(renderToStaticMarkup(<AgentIcon name="home" solid />)).toContain("data-solid");
    expect(renderToStaticMarkup(<AgentIcon name="home" />)).not.toContain("data-solid");
    // No twin: falls back to the outline instead of drawing nothing.
    const send = renderToStaticMarkup(<AgentIcon name="send" solid />);
    expect(send).not.toContain("data-solid");
    expect(send).toContain('d="M12 19V5"');
  });

  it("draws authored sizes at one size per place", () => {
    const drawn = (size: number) =>
      renderToStaticMarkup(<AgentIcon name="plus" size={size} />).match(/width:min\(calc\(([\d.]+)px/)?.[1];
    expect(drawn(11)).toBe("14");
    expect(drawn(13)).toBe("14");
    expect(drawn(14)).toBe("16");
    expect(drawn(17)).toBe("18");
    expect(drawn(18)).toBe("20");
    expect(drawn(24)).toBe("24");
  });

  it("uses the bold stroke unless a caller overrides it", () => {
    expect(renderToStaticMarkup(<AgentIcon name="plus" />)).toContain('stroke-width="2"');
    expect(renderToStaticMarkup(<AgentIcon name="plus" strokeWidth={3} />)).toContain('stroke-width="3"');
  });
});
