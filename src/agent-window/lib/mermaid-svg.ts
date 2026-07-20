interface MermaidSvgSize {
  width: number;
  height: number;
}

const capDimension = (value: number): number => Math.min(50_000, Math.max(1, value));

export const readMermaidSvgSize = (svg: string): MermaidSvgSize => {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { width: capDimension(viewBox[2]), height: capDimension(viewBox[3]) };
  }
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  return {
    width: capDimension(Number.isFinite(width) && width > 0 ? width : 800),
    height: capDimension(Number.isFinite(height) && height > 0 ? height : 600),
  };
};
