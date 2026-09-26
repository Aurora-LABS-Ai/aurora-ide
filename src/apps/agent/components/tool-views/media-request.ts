/**
 * The facts a picture or video card states about its request. Rendering lives
 * in `MediaRequest.tsx`; these are plain functions so they can be tested and
 * shared without breaking fast refresh.
 */

const MEDIA_TOOLS = new Set(["generate_image", "generate_video"]);

/** Tools whose request renders as a caption instead of argument chips. */
export function isMediaTool(name: string): boolean {
  return MEDIA_TOOLS.has(name);
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/**
 * The provider the result says answered. The Rust caption reads
 * `… with <model> via <provider> in 7s.`, and a call that named no provider
 * only has this to go on. A failure reads `<model> via <provider>: …`.
 */
export function providerFromResult(result: string | undefined): string {
  if (!result) return "";
  const done = /\bvia (.+?) in \d+s\./.exec(result);
  if (done) return done[1].trim();
  // Tried second: a success caption can hold a colon later ("rewrote the
  // prompt as: …") that this looser shape would otherwise catch.
  const failed = /\S+ via ([^:\n]+): /.exec(result);
  return failed ? failed[1].trim() : "";
}

/** Model, provider and shape, in the order a reader compares them. */
export function mediaRequestFacts(
  name: string,
  args: Record<string, unknown>,
  result?: string,
): string[] {
  const facts: string[] = [];
  // Listing models and checking a video job ask for nothing.
  const op = text(args.op);
  if (op === "list" || op === "query") return facts;
  const model = text(args.model);
  if (model) facts.push(model);
  const provider = text(args.provider) || providerFromResult(result);
  if (provider) facts.push(provider);
  if (name === "generate_image") {
    const size = text(args.size);
    if (size) facts.push(size.replace(/[xX]/, "×"));
    const source = text(args.source);
    if (op === "edit" && source) facts.push(`from ${source}`);
  } else {
    if (typeof args.duration === "number") facts.push(`${args.duration}s`);
    const resolution = text(args.resolution);
    if (resolution) facts.push(resolution);
    const ratio = text(args.ratio);
    if (ratio) facts.push(ratio);
  }
  return facts;
}
