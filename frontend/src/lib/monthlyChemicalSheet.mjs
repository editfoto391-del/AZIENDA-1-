export const MONTHLY_SHEET_CHEMICALS = [
  { key: "ppg", label: "PPG (Polyol)" },
  { key: "tdi", label: "TDI (Isocyanate)" },
  { key: "t9", label: "T-9 Catalyst" },
  { key: "silicone", label: "Silicone" },
  { key: "amine52", label: "Amine 52" },
  { key: "mcl", label: "MCL" },
];

export const MONTHLY_SHEET_BLOCKS = [
  { key: "big_block", label: "Big Block" },
  { key: "big_blue_block", label: "Big Blue Block" },
  { key: "medium_block", label: "Medium Block" },
  { key: "small_block", label: "Small Block" },
  { key: "small_blue_block", label: "Small Blue Block" },
];

const blankChemicalValues = () => Object.fromEntries(
  MONTHLY_SHEET_CHEMICALS.map(({ key }) => [key, ""]),
);

const blankWeek = () => ({
  ...Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [key, { quantity: "", weight_kg: "" }])),
});

export function monthlyWeekCount(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mondayOffset = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  return Math.ceil((mondayOffset + daysInMonth) / 7);
}

export function createBlankMonthlySheet(month, formulaRates = {}) {
  return {
    month,
    arrivals: blankChemicalValues(),
    arrival_sources: [],
    minimums: blankChemicalValues(),
    formula_rates: Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [
      key,
      { ...blankChemicalValues(), ...(formulaRates[key] || {}) },
    ])),
    weeks: Array.from({ length: monthlyWeekCount(month) }, blankWeek),
  };
}

function numericValue(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function emptyContainerCount(used, total, capacity, count) {
  if (total - used <= 1e-8) return count;
  return Math.min(count, Math.floor((used + 1e-8) / capacity));
}

export function calculateMonthlySheet(sheet) {
  const importedArrivals = Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key }) => [
    key,
    (sheet.arrival_sources || []).reduce((total, source) => total + (source.lines || [])
      .filter((line) => line.chemical_key === key)
      .reduce((lineTotal, line) => lineTotal + (numericValue(line.quantity_kg) || 0), 0), 0),
  ]));
  const blockTotals = Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [
    key,
    (sheet.weeks || []).reduce((total, week) => ({
      quantity: total.quantity + (numericValue(week[key]?.quantity) || 0),
      weight_kg: total.weight_kg + (numericValue(week[key]?.weight_kg) || 0),
    }), { quantity: 0, weight_kg: 0 }),
  ]));
  const totalBlocks = Object.values(blockTotals).reduce((total, item) => total + item.quantity, 0);
  const totalBlockWeight = Object.values(blockTotals).reduce((total, item) => total + item.weight_kg, 0);
  const totalArrivals = MONTHLY_SHEET_CHEMICALS.reduce(
    (total, { key }) => total + (numericValue(sheet.arrivals?.[key]) || 0) + importedArrivals[key], 0,
  );
  const chemicalBalances = Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key }) => {
    const missingRates = MONTHLY_SHEET_BLOCKS
      .filter(({ key: blockKey }) => blockTotals[blockKey].quantity > 0
        && numericValue(sheet.formula_rates?.[blockKey]?.[key]) == null)
      .map(({ label }) => label);
    const consumption = missingRates.length ? null : MONTHLY_SHEET_BLOCKS.reduce(
      (total, { key: blockKey }) => total
        + blockTotals[blockKey].quantity * (numericValue(sheet.formula_rates?.[blockKey]?.[key]) || 0),
      0,
    );
    const manualArrival = numericValue(sheet.arrivals?.[key]);
    const arrival = manualArrival == null && importedArrivals[key] === 0
      ? null
      : (manualArrival || 0) + importedArrivals[key];
    const remaining = arrival == null || consumption == null ? null : arrival - consumption;
    const minimum = numericValue(sheet.minimums?.[key]);
    return [key, {
      arrival,
      manualArrival,
      importedArrival: importedArrivals[key],
      consumption,
      remaining,
      minimum,
      missingRates,
      status: remaining == null
        ? arrival == null ? "missing-arrival" : "missing-formula"
        : minimum == null ? "set-minimum" : remaining < minimum ? "reorder" : "ok",
    }];
  }));
  const containerTracking = MONTHLY_SHEET_CHEMICALS.map(({ key: chemicalKey, label }) => {
    const balance = chemicalBalances[chemicalKey];
    const containers = (sheet.arrival_sources || [])
      .flatMap((source) => (source.lines || []).map((line) => ({
        ...line,
        grv_number: source.grv_number || source.grv_id,
        supplier_name: source.supplier_name || "",
        received_date: source.received_date || "",
      })))
      .filter((line) => line.chemical_key === chemicalKey
        && numericValue(line.container_capacity) > 0
        && numericValue(line.container_count) > 0
        && ["kg", "kgs", "kilogram", "kilograms"].includes(
          String(line.unit || "").trim().toLowerCase(),
        ))
      .sort((left, right) => left.received_date.localeCompare(right.received_date)
        || left.grv_number.localeCompare(right.grv_number)
        || left.line_index - right.line_index)
      .map((line) => ({
        ...line,
        container_capacity: numericValue(line.container_capacity),
        container_count: numericValue(line.container_count),
        total_quantity_kg: numericValue(line.quantity_kg)
          ?? numericValue(line.container_capacity) * numericValue(line.container_count),
        estimated_used_kg: 0,
        depletion_week: null,
      }));
    let activeContainers = [];
    let nextReceiptIndex = 0;
    let untrackedConsumption = 0;
    const missingRates = new Set(balance.missingRates);

    (sheet.weeks || []).forEach((week, weekIndex) => {
      const monthStart = new Date(`${sheet.month}-01T00:00:00Z`);
      const weekStart = new Date(monthStart);
      weekStart.setUTCDate(weekStart.getUTCDate() - ((weekStart.getUTCDay() + 6) % 7) + weekIndex * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
      const weekEndDate = weekEnd.toISOString().slice(0, 10);
      while (nextReceiptIndex < containers.length
        && containers[nextReceiptIndex].received_date <= weekEndDate) {
        activeContainers.push(containers[nextReceiptIndex]);
        nextReceiptIndex += 1;
      }

      let weeklyConsumption = 0;
      MONTHLY_SHEET_BLOCKS.forEach(({ key: blockKey }) => {
        const quantity = numericValue(week[blockKey]?.quantity) || 0;
        const rate = numericValue(sheet.formula_rates?.[blockKey]?.[chemicalKey]);
        if (quantity > 0 && rate == null) missingRates.add(blockKey);
        else weeklyConsumption += quantity * (rate || 0);
      });
      if (missingRates.size) return;

      let remainingConsumption = weeklyConsumption;
      activeContainers.forEach((container) => {
        if (remainingConsumption <= 0) return;
        const containerTotal = container.total_quantity_kg;
        const remainingInLot = Math.max(0, containerTotal - container.estimated_used_kg);
        const usedBefore = container.estimated_used_kg;
        const allocated = Math.min(remainingConsumption, remainingInLot);
        container.estimated_used_kg += allocated;
        remainingConsumption -= allocated;
        const emptyBefore = emptyContainerCount(
          usedBefore, containerTotal, container.container_capacity, container.container_count,
        );
        const emptyAfter = emptyContainerCount(
          container.estimated_used_kg, containerTotal, container.container_capacity, container.container_count,
        );
        if (emptyAfter > emptyBefore && container.depletion_week == null) {
          container.depletion_week = weekIndex + 1;
        }
      });
      untrackedConsumption += remainingConsumption;
    });

    const missingRateLabels = MONTHLY_SHEET_BLOCKS
      .filter(({ key: blockKey }) => missingRates.has(blockKey))
      .map(({ label: blockLabel }) => blockLabel);
    return {
      chemical_key: chemicalKey,
      chemical_label: label,
      containers: containers.map((container) => {
        const total = container.total_quantity_kg;
        const remaining = Math.max(0, total - container.estimated_used_kg);
        return {
          ...container,
          remaining_quantity_kg: remaining,
          empty_container_count: emptyContainerCount(
            container.estimated_used_kg, total, container.container_capacity, container.container_count,
          ),
          containers_with_stock: remaining > 1e-8
            ? Math.min(container.container_count, Math.ceil((remaining - 1e-8) / container.container_capacity))
            : 0,
          status: missingRateLabels.length
            ? "missing-formula"
            : remaining <= 1e-8 ? "empty"
              : container.estimated_used_kg > 1e-8 ? "in-use" : "full",
        };
      }),
      missing_rates: missingRateLabels,
      untracked_consumption_kg: missingRateLabels.length ? null : untrackedConsumption,
      tracked_quantity_kg: containers.reduce((sum, container) => sum + container.total_quantity_kg, 0),
      tracked_remaining_kg: containers.reduce((sum, container) =>
        sum + Math.max(0, container.total_quantity_kg - container.estimated_used_kg), 0),
    };
  });
  return {
    blockTotals, totalBlocks, totalBlockWeight, totalArrivals, chemicalBalances, containerTracking,
  };
}

export function monthlySheetPayload(sheet) {
  const numberOrNull = (value) => value === "" || value == null ? null : Number(value);
  return {
    month: sheet.month,
    arrivals: Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key }) => [key, numberOrNull(sheet.arrivals[key])])),
    arrival_sources: (sheet.arrival_sources || []).map((source) => ({
      grv_id: source.grv_id,
      lines: source.lines.map((line) => ({
        line_index: line.line_index,
        chemical_key: line.chemical_key,
      })),
    })),
    minimums: Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key }) => [key, numberOrNull(sheet.minimums[key])])),
    formula_rates: Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key: blockKey }) => [
      blockKey,
      Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key: chemicalKey }) => [
        chemicalKey, numberOrNull(sheet.formula_rates[blockKey][chemicalKey]),
      ])),
    ])),
    weeks: sheet.weeks.map((week) => Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [
      key,
      {
        quantity: numberOrNull(week[key].quantity),
        weight_kg: numberOrNull(week[key].weight_kg),
      },
    ]))),
  };
}
