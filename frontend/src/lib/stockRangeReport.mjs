const WEEKLY_RANGE_SIZES = ["760x50", "760x75", "760x100", "760x120", "760x150", "910x50", "910x75", "910x100", "910x120", "910x150", "1070x50", "1070x75", "1070x100", "1070x120", "1070x150", "1370x50", "1370x75", "1370x100", "1370x120", "1370x150"];
const RIBBON_SIZES = ["760", "910", "1070", "1370"].flatMap((width) =>
  ["100", "120", "150"].map((height) => `${width}x${height}`)
);
const CANDY_SIZES = [...RIBBON_SIZES];

const ribbonRows = RIBBON_SIZES.flatMap((size, index) => [
  { number: 21 + index * 2, size, type: "RIBBON BLACK", group: "ribbon-black" },
  { number: 22 + index * 2, size, type: "RIBBON PINK", group: "ribbon-pink" },
]);

export const PRODUCT_RANGE_SECTIONS = [
  {
    title: "MIX-COLOR RANGE",
    columns: ["#", "SIZE (mm)", "TYPE", "QTY / STOCK"],
    rows: WEEKLY_RANGE_SIZES.map((size, index) => ({ number: index + 1, size, type: "MIX-COLOR", group: "mix" })),
  },
  {
    title: "RIBBON RANGE",
    columns: ["#", "SIZE (mm)", "COLOR", "QTY / STOCK"],
    rows: ribbonRows,
  },
  {
    title: "CANDY RANGE",
    columns: ["#", "SIZE (mm)", "TYPE", "QTY / STOCK"],
    rows: CANDY_SIZES.map((size, index) => ({ number: index + 45, size, type: "CANDY", group: "candy" })),
  },
  {
    title: "STRONG BOY RANGE",
    columns: ["#", "SIZE (mm)", "TYPE", "QTY / STOCK"],
    rows: ["760x125", "910x125", "1070x125", "1370x125"].map((size, index) => ({
      number: index + 57, size, type: "STRONG BOY", group: "strong-boy",
    })),
  },
  {
    title: "UNCOVERED RANGE",
    columns: ["#", "SIZE (mm)", "TYPE", "QTY / STOCK"],
    rows: ["910x100", "1070x100"].map((size, index) => ({
      number: index + 61, size, type: "UNCOVERED (BLUE 16 DENSITY)", group: "uncovered-blue",
    })),
  },
];

export const PRODUCT_RANGE_PAGES = [
  {
    title: "PRODUCT RANGE REPORT - PAGE 1 OF 2",
    sectionTitles: ["MIX-COLOR RANGE", "RIBBON RANGE"],
  },
  {
    title: "PRODUCT RANGE REPORT - PAGE 2 OF 2",
    sectionTitles: ["CANDY RANGE", "STRONG BOY RANGE", "UNCOVERED RANGE"],
  },
].map((page) => ({
  ...page,
  sections: page.sectionTitles.map((title) => PRODUCT_RANGE_SECTIONS.find((section) => section.title === title)),
}));

export const REPORT_PRODUCT_NAMES = {
  mix: new Set(["simple", "standard", "simplemixcolor", "mixcolor"]),
  "ribbon-black": new Set(["ribbonblack", "ribbonbalck", "black"]),
  "ribbon-pink": new Set(["ribbonpink", "ribbon"]),
  candy: new Set(["candy"]),
  "strong-boy": new Set(["strongboy"]),
  "uncovered-blue": new Set(["uncoveredblue16density"]),
};

export const normalizeReportValue = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
