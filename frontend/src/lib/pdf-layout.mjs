export const PDF_SNAPSHOT_WIDTH_PX = 794;

export function buildPdfSnapshotLayout({ scrollWidth, offsetWidth } = {}) {
  const measuredWidth = Number.isFinite(scrollWidth)
    ? scrollWidth
    : Number.isFinite(offsetWidth)
      ? offsetWidth
      : PDF_SNAPSHOT_WIDTH_PX;

  const safeWidth = Math.min(
    Math.max(Math.round(measuredWidth), PDF_SNAPSHOT_WIDTH_PX),
    PDF_SNAPSHOT_WIDTH_PX,
  );

  return {
    cloneWidth: safeWidth,
    wrapperWidth: safeWidth,
    allowOversize: false,
  };
}
