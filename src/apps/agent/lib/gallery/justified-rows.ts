/**
 * Justified rows for a picture wall (pure).
 *
 * Pictures sit in rows of equal height, each at its true shape, read left to
 * right — the order is the order given. A row is filled until making it as
 * wide as the wall would bring its height down to the target, then scaled to
 * fit exactly. The last row is not stretched (three pictures would balloon to
 * fill the width); it keeps the target height and stays left-aligned.
 *
 * Replaces CSS `columns` masonry, which fills each column top to bottom: a
 * newest-first list read down the first column, and inserting one picture at
 * the front moved every other picture to a different column.
 */

export interface RowItem {
  key: string;
  /** width / height. */
  ratio: number;
}

export interface RowBox {
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RowOptions {
  /** Height a full row aims for. */
  targetHeight: number;
  gap: number;
}

/**
 * Extreme shapes clamped, so a 1:8 strip cannot become a 3px sliver beside
 * its neighbours, nor an 8:1 banner take a whole row by itself.
 */
const MIN_RATIO = 0.4;
const MAX_RATIO = 2.6;
export const clampRatio = (ratio: number): number =>
  Number.isFinite(ratio) && ratio > 0 ? Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) : 1;

/** Boxes for `items` in a wall `width` px wide, and the total height used. */
export function layoutRows(
  items: readonly RowItem[],
  width: number,
  { targetHeight, gap }: RowOptions,
): { boxes: RowBox[]; height: number } {
  const boxes: RowBox[] = [];
  if (width <= 0 || items.length === 0) return { boxes, height: 0 };

  let y = 0;
  let row: RowItem[] = [];
  let ratioSum = 0;

  const place = (height: number) => {
    let x = 0;
    for (const item of row) {
      const w = height * clampRatio(item.ratio);
      boxes.push({ key: item.key, x, y, width: w, height });
      x += w + gap;
    }
    y += height + gap;
    row = [];
    ratioSum = 0;
  };

  for (const item of items) {
    row.push(item);
    ratioSum += clampRatio(item.ratio);
    const fitted = (width - gap * (row.length - 1)) / ratioSum;
    if (fitted <= targetHeight) place(fitted);
  }
  // The last row: never taller than the target, never stretched to the edge.
  if (row.length > 0) {
    const fitted = (width - gap * (row.length - 1)) / ratioSum;
    place(Math.min(targetHeight, fitted));
  }
  return { boxes, height: Math.max(0, y - gap) };
}
