/**
 * Agent Window — the media wall: justified rows grouped by day [view].
 *
 * Shared by the Images page and the Library. Newest first, read left to right,
 * under Today / Yesterday / weekday / date headings; every picture at its true
 * shape (`lib/gallery/justified-rows`). Design: Documents/
 * aurora-image-wall-designs.html, variant 03.
 *
 * Motion, so nothing jumps:
 *  - every tile is absolutely placed and keyed by its gallery id; when the
 *    layout changes it GLIDES to its new box (a CSS transition on transform);
 *  - a tile that was not on the wall before fades and scales in — but not on
 *    first paint, where the whole wall appearing at once would be noise;
 *  - a tile that leaves (deleted) fades out in place while the rest close up;
 *  - first open with nothing loaded draws skeleton rows in real proportions.
 * The window's Reduce motion setting turns the glides and fades off.
 */

import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { groupByDay } from "@/apps/agent/lib/gallery/day-groups";
import { layoutRows, type RowBox } from "@/apps/agent/lib/gallery/justified-rows";
import { AGW_DURATION } from "@/apps/agent/theme/motion";
import type { GalleryImage } from "@/apps/agent/services/gallery/gallery-service";
import type { ImageJob } from "@/apps/agent/store/images/useAgentImagesStore";
import { WallTile } from "./WallTile";

export type WallEntry =
  | { kind: "image"; key: string; image: GalleryImage }
  | { kind: "job"; key: string; job: ImageJob };

export interface MediaWallProps {
  entries: readonly WallEntry[];
  /** True while the first list is loading; draws skeleton rows when empty. */
  loading: boolean;
  /** Shown when there is nothing and nothing is loading. */
  empty: React.ReactNode;
  selectedKey?: string | null;
  isHidden: (image: GalleryImage) => boolean;
  onOpen: (image: GalleryImage) => void;
  onPreview: (image: GalleryImage) => void;
  onMenu: (
    event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
    image: GalleryImage,
  ) => void;
  onToggleHidden: (image: GalleryImage) => void;
  onDelete: (image: GalleryImage) => void;
  onRetry?: (job: ImageJob) => void;
  onDismiss?: (job: ImageJob) => void;
  /** Accessible name for the wall region. */
  label: string;
}

const TARGET_HEIGHT = 210;
const GAP = 8;
const HEADER_HEIGHT = 30;
const GROUP_GAP = 22;
/** Width assumed until the first measurement (and in a test DOM with none). */
const FALLBACK_WIDTH = 960;
const PAGE = 120;
/** How long a leaving/entering tile animates — `--agw-dur-slow`, from the same source. */
const LEAVE_MS = AGW_DURATION.slow * 1000;
/** Shapes the skeleton borrows, so it reads as pictures, not a grid of boxes. */
const SKELETON_RATIOS = [1, 1.5, 0.67, 1.78, 1, 0.75, 1.5, 1, 1.33, 0.67, 1.78, 1];

interface Placed {
  key: string;
  box: RowBox;
  entry?: WallEntry;
}
interface Heading {
  key: string;
  label: string;
  count: number;
  y: number;
}

const ratioOf = (entry: WallEntry): number => {
  if (entry.kind === "job") {
    if (entry.job.result) return entry.job.result.width / Math.max(1, entry.job.result.height);
    const [w, h] = entry.job.aspectRatio.split("/").map((part) => Number(part.trim()));
    return w > 0 && h > 0 ? w / h : 1;
  }
  return entry.image.width / Math.max(1, entry.image.height);
};

const dateOf = (entry: WallEntry): string | undefined =>
  entry.kind === "job" ? new Date(entry.job.startedAt).toISOString() : entry.image.createdAt;

export const MediaWall: React.FC<MediaWallProps> = ({
  entries,
  loading,
  empty,
  selectedKey,
  isHidden,
  onOpen,
  onPreview,
  onMenu,
  onToggleHidden,
  onDelete,
  onRetry,
  onDismiss,
  label,
}) => {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [limit, setLimit] = useState(PAGE);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    const measure = () => setWidth(Math.floor(node.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const shown = useMemo(() => entries.slice(0, limit), [entries, limit]);
  const skeleton = loading && entries.length === 0;
  const wallWidth = width || FALLBACK_WIDTH;
  // Tiles are only drawn once the real width is known (measured in a layout
  // effect, so before the first paint). Drawing at the fallback first and then
  // correcting made every tile glide across the page on each visit.
  const measured = width > 0 || typeof ResizeObserver === "undefined";
  // Glides are for changes WHILE you look at the wall, never for its arrival.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!measured || settled) return;
    const frame = window.requestAnimationFrame(() => setSettled(true));
    return () => window.cancelAnimationFrame(frame);
  }, [measured, settled]);

  const { placed, headings, height } = useMemo(() => {
    const placedOut: Placed[] = [];
    const headingsOut: Heading[] = [];
    let y = 0;
    if (skeleton) {
      headingsOut.push({ key: "skeleton", label: "", count: 0, y });
      y += HEADER_HEIGHT;
      const { boxes, height: h } = layoutRows(
        SKELETON_RATIOS.map((ratio, i) => ({ key: `sk${i}`, ratio })),
        wallWidth,
        { targetHeight: TARGET_HEIGHT, gap: GAP },
      );
      for (const box of boxes) placedOut.push({ key: box.key, box: { ...box, y: box.y + y } });
      return { placed: placedOut, headings: headingsOut, height: y + h };
    }
    for (const group of groupByDay(shown, dateOf)) {
      headingsOut.push({
        key: group.key,
        label: group.label,
        count: group.items.filter((entry) => entry.kind === "image").length,
        y,
      });
      y += HEADER_HEIGHT;
      const { boxes, height: h } = layoutRows(
        group.items.map((entry) => ({ key: entry.key, ratio: ratioOf(entry) })),
        wallWidth,
        { targetHeight: TARGET_HEIGHT, gap: GAP },
      );
      const byKey = new Map(group.items.map((entry) => [entry.key, entry]));
      for (const box of boxes) {
        placedOut.push({ key: box.key, box: { ...box, y: box.y + y }, entry: byKey.get(box.key) });
      }
      y += h + GROUP_GAP;
    }
    return { placed: placedOut, headings: headingsOut, height: Math.max(0, y - GROUP_GAP) };
  }, [shown, skeleton, wallWidth]);

  // Which keys were on the wall before: new ones animate in, gone ones out.
  // Kept in STATE for the length of the animation — derived during render, a
  // re-render mid-fade (the gallery's own refresh) dropped the attribute and
  // cut the animation off. Set in a layout effect, so the first frame of a new
  // tile is already the animated one, never a flash at full opacity.
  const lastPlaced = useRef<Map<string, Placed> | null>(null);
  const [entering, setEntering] = useState<ReadonlySet<string>>(new Set());
  const [leaving, setLeaving] = useState<Placed[]>([]);
  const timers = useRef<number[]>([]);

  useLayoutEffect(() => {
    if (skeleton) return;
    const before = lastPlaced.current;
    lastPlaced.current = new Map(placed.map((p) => [p.key, p]));
    // First real paint: nothing "enters"; the wall simply is.
    if (!before) return;
    const now = new Set(placed.map((p) => p.key));
    const fresh = placed.filter((p) => !before.has(p.key)).map((p) => p.key);
    const gone = [...before.values()].filter((p) => !now.has(p.key) && p.entry);
    if (fresh.length) {
      setEntering((current) => new Set([...current, ...fresh]));
      timers.current.push(
        window.setTimeout(
          () => setEntering((current) => new Set([...current].filter((k) => !fresh.includes(k)))),
          LEAVE_MS + 120,
        ),
      );
    }
    if (gone.length) {
      setLeaving((current) => [...current, ...gone]);
      const keys = new Set(gone.map((p) => p.key));
      timers.current.push(
        window.setTimeout(() => setLeaving((current) => current.filter((p) => !keys.has(p.key))), LEAVE_MS),
      );
    }
  }, [placed, skeleton]);

  useEffect(() => () => timers.current.forEach((id) => window.clearTimeout(id)), []);

  const style = (box: RowBox): React.CSSProperties => ({
    width: box.width,
    height: box.height,
    transform: `translate(${box.x}px, ${box.y}px)`,
  });

  // The host stays mounted through the empty state: it is what the
  // ResizeObserver measures, and swapping it out lost the width.
  return (
    <div ref={host} className="agw-wall-host" aria-busy={skeleton || undefined}>
      {!measured ? null : !skeleton && entries.length === 0 && leaving.length === 0 ? (
        <div className="agw-wall-empty" role="status">
          {empty}
        </div>
      ) : (
      <div
        className="agw-wall"
        role="region"
        aria-label={label}
        data-settled={settled || undefined}
        style={{ height }}
      >
        {headings.map((heading) =>
          skeleton ? (
            <span key={heading.key} className="agw-wall-day agw-wall-day-skeleton" style={{ top: heading.y }} />
          ) : (
            <h3 key={heading.key} className="agw-wall-day" style={{ top: heading.y }}>
              {heading.label}
              {heading.count > 0 && <span>{heading.count}</span>}
            </h3>
          ),
        )}
        {placed.map(({ key, box, entry }) =>
          !entry ? (
            <div key={key} className="agw-wall-slot agw-wall-skeleton" style={style(box)} aria-hidden="true" />
          ) : (
            <div
              key={key}
              className="agw-wall-slot"
              data-enter={entering.has(key) || undefined}
              style={style(box)}
            >
              {entry.kind === "image" ? (
                <WallTile
                  image={entry.image}
                  hidden={isHidden(entry.image)}
                  selected={selectedKey === key}
                  onOpen={() => onOpen(entry.image)}
                  onPreview={() => onPreview(entry.image)}
                  onMenu={(event) => onMenu(event, entry.image)}
                  onToggleHidden={() => onToggleHidden(entry.image)}
                  onDelete={() => onDelete(entry.image)}
                />
              ) : (
                <WallTile
                  job={entry.job}
                  hidden={false}
                  selected={false}
                  onRetry={() => onRetry?.(entry.job)}
                  onDismiss={() => onDismiss?.(entry.job)}
                />
              )}
            </div>
          ),
        )}
        {/* A tile on its way out keeps its picture while it fades, so a
            landing reads as the silk dissolving into the picture and a delete
            as the picture leaving — not an empty box blinking. */}
        {leaving.map(({ key, box, entry }) => (
          <div key={`leave:${key}`} className="agw-wall-slot agw-wall-leaving" style={style(box)} aria-hidden="true">
            {entry?.kind === "image" ? (
              <WallTile image={entry.image} hidden={isHidden(entry.image)} selected={false} />
            ) : entry ? (
              <WallTile job={entry.job} hidden={false} selected={false} />
            ) : null}
          </div>
        ))}
      </div>
      )}
      {entries.length > limit && (
        <button type="button" className="agw-wall-more" onClick={() => setLimit((n) => n + PAGE)}>
          Show more ({entries.length - limit})
        </button>
      )}
    </div>
  );
};
