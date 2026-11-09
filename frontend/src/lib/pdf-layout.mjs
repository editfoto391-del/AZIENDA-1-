export const PDF_SNAPSHOT_WIDTH_PX = 794;

export function getPdfImageLayout(canvasWidth, canvasHeight, pageWidth = 210, pageHeight = 297) {
  const renderedHeight = (canvasHeight * pageWidth) / canvasWidth;
  if (renderedHeight <= pageHeight * 1.03) {
    const scale = Math.min(1, pageHeight / renderedHeight);
    const imageWidth = pageWidth * scale;
    return {
      pageCount: 1,
      x: (pageWidth - imageWidth) / 2,
      width: imageWidth,
      height: renderedHeight * scale,
    };
  }

  return {
    pageCount: Math.ceil(renderedHeight / pageHeight),
    x: 0,
    width: pageWidth,
    height: renderedHeight,
  };
}

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
