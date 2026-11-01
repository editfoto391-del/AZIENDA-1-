import { buildPdfSnapshotLayout } from "./pdf-layout.mjs";

export async function elementToPdf(el, filename = "document.pdf") {
  if (!el) throw new Error("PDF target is not ready yet.");

  const { cloneWidth, wrapperWidth } = buildPdfSnapshotLayout({
    scrollWidth: el.scrollWidth || 0,
    offsetWidth: el.offsetWidth || 0,
  });

  const clone = el.cloneNode(true);
  clone.style.position = "fixed";
  clone.style.left = "0";
  clone.style.top = "0";
  clone.style.width = `${cloneWidth}px`;
  clone.style.minWidth = `${cloneWidth}px`;
  clone.style.maxWidth = "none";
  clone.style.zIndex = "2147483647";
  clone.style.visibility = "visible";
  clone.style.opacity = "1";
  clone.style.background = "#ffffff";
  clone.style.pointerEvents = "none";
  clone.style.overflow = "visible";

  clone.querySelectorAll(".no-print").forEach((node) => {
    node.style.display = "none";
  });

  const wrapper = document.createElement("div");
  wrapper.style.position = "absolute";
  wrapper.style.left = "-99999px";
  wrapper.style.top = "0";
  wrapper.style.width = `${wrapperWidth}px`;
  wrapper.style.pointerEvents = "none";
  wrapper.appendChild(clone);
  document.body.appendChild(wrapper);

  try {
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import("html2canvas-pro"),
      import("jspdf"),
    ]);
    const canvas = await html2canvas(clone, {
      scale: 2,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      width: clone.scrollWidth || clone.offsetWidth || 794,
      height: clone.scrollHeight || clone.offsetHeight || 1200,
      scrollX: 0,
      scrollY: 0,
      windowWidth: Math.max(document.documentElement.clientWidth, window.innerWidth || 1200),
      windowHeight: Math.max(document.documentElement.clientHeight, window.innerHeight || 1200),
    });

    const pdf = new jsPDF({ unit: "mm", format: "a4" });
    const pageWidth = 210;
    const pageHeight = 297;
    const renderedHeight = (canvas.height * pageWidth) / canvas.width;
    const img = canvas.toDataURL("image/png");

    pdf.addImage(img, "PNG", 0, 0, pageWidth, renderedHeight);
    for (let offset = renderedHeight - pageHeight; offset > 0; offset -= pageHeight) {
      pdf.addPage();
      pdf.addImage(img, "PNG", 0, -offset, pageWidth, renderedHeight);
    }

    pdf.save(filename);
  } finally {
    wrapper.remove();
  }
}

export function printElement(el, title) {
  const w = window.open("", "_blank");
  if (!w) return false;
  w.document.write(`<html><head><title>${title}</title>${document.head.innerHTML}<style>@page{size:A4;margin:10mm}body{background:#fff!important}</style></head><body>${el.outerHTML}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 600);
  return true;
}
