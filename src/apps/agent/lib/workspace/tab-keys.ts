/**
 * Which tab a key moves to in the dock's tab strip.
 *
 * Left/Right step to the previous/next tab and wrap at the ends, the way a
 * browser's Ctrl+Tab does; Home/End jump to the first/last. Any other key —
 * or a strip with nowhere to go — is `null`, so the caller leaves the event
 * alone.
 */
export function tabIndexForKey(key: string, index: number, count: number): number | null {
  if (count < 2) return null;
  let target: number;
  switch (key) {
    case "ArrowRight":
      target = (index + 1) % count;
      break;
    case "ArrowLeft":
      target = (index - 1 + count) % count;
      break;
    case "Home":
      target = 0;
      break;
    case "End":
      target = count - 1;
      break;
    default:
      return null;
  }
  return target === index ? null : target;
}
