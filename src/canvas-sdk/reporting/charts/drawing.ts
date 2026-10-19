import type { KeyboardEvent, SVGProps } from "react";
import type { ChartPoint } from "../data";
import type { ChartSpec } from "../types";

export interface DrawingProps {
  spec: ChartSpec;
  width: number;
  points: ChartPoint[];
  series: { key: string; index: number }[];
  selected?: string;
  onSelect?: (label: string) => void;
  onInspect: (text: string | null) => void;
}

export function markProps(label: string, description: string, props: DrawingProps): SVGProps<SVGElement> & { "data-selected"?: boolean } {
  return {
    className: "ac-plot-mark",
    role: props.onSelect ? "button" : "img",
    tabIndex: 0,
    "aria-label": description,
    "aria-pressed": props.onSelect ? props.selected === label : undefined,
    "data-selected": props.selected === label || undefined,
    onMouseEnter: () => props.onInspect(description),
    onMouseLeave: () => props.onInspect(null),
    onFocus: () => props.onInspect(description),
    onBlur: () => props.onInspect(null),
    onClick: props.onSelect ? () => props.onSelect?.(label) : undefined,
    onKeyDown: props.onSelect ? (event: KeyboardEvent<SVGElement>) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onSelect?.(label); }
    } : undefined,
  };
}

export const shortLabel = (label: string, length = 18) => label.length > length ? `${label.slice(0, length - 1)}…` : label;
export const seriesColor = (index: number) => `var(--ac-chart-${index % 6})`;
