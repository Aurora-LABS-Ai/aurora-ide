import { describe, expect, it } from "vitest";

import { splitError } from "./mcp-status";

describe("splitError", () => {
  it("separates Aurora's sentence from the server's output", () => {
    const error =
      "The server process stopped.\n\nThe server's last output:\nnpm ERR! code E404\nnpm ERR! 404 Not Found";
    expect(splitError(error)).toEqual({
      message: "The server process stopped.",
      output: "npm ERR! code E404\nnpm ERR! 404 Not Found",
    });
  });

  it("keeps a sentence with no output whole", () => {
    expect(splitError("'foo' was not found.")).toEqual({ message: "'foo' was not found." });
  });

  it("has nothing to show for no error", () => {
    expect(splitError(undefined)).toBeNull();
    expect(splitError("  ")).toBeNull();
  });
});
