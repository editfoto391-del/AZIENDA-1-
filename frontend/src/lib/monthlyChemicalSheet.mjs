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

const blankProductionDay = (date, weekIndex) => ({
  date,
  week_index: weekIndex,
  ...blankWeek(),
});

export function monthlyWeekCount(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mondayOffset = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  return Math.ceil((mondayOffset + daysInMonth) / 7);
}

export function monthlyProductionDays(month) {
  const [year, monthNumber] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const mondayOffset = (new Date(Date.UTC(year, monthNumber - 1, 1)).getUTCDay() + 6) % 7;
  return Array.from({ length: daysInMonth }, (_, index) => {
    const day = index + 1;
    return blankProductionDay(
      `${month}-${String(day).padStart(2, "0")}`,
      Math.floor((mondayOffset + index) / 7),
    );
  });
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
    production_days: monthlyProductionDays(month),
  };
}

function numericValue(value) {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function hasProductionEntry(row) {
  return MONTHLY_SHEET_BLOCKS.some(({ key }) =>
    row[key]?.quantity !== "" && row[key]?.quantity != null
      || row[key]?.weight_kg !== "" && row[key]?.weight_kg != null);
}

function productionTotalsByWeek(sheet) {
  const days = sheet.production_days || [];
  const [, monthNumber] = sheet.month.split("-").map(Number);
  const mondayOffset = (new Date(Date.UTC(
    Number(sheet.month.slice(0, 4)), monthNumber - 1, 1,
  )).getUTCDay() + 6) % 7;
  const weekIndexOf = (day) => day.week_index ?? Math.floor(
    (mondayOffset + Number(day.date.slice(-2)) - 1) / 7,
  );
  return Array.from({ length: monthlyWeekCount(sheet.month) }, (_, weekIndex) => {
    const weekDays = days.filter((day) => weekIndexOf(day) === weekIndex);
    const dailyEntriesExist = weekDays.some(hasProductionEntry);
    const dayRows = dailyEntriesExist
      ? weekDays
      : (sheet.weeks || [])[weekIndex] ? [(sheet.weeks || [])[weekIndex]] : [];
    return MONTHLY_SHEET_BLOCKS.reduce((weekTotal, { key }) => ({
      ...weekTotal,
      [key]: dayRows.reduce((blockTotal, row) => ({
        quantity: blockTotal.quantity + (numericValue(row[key]?.quantity) || 0),
        weight_kg: blockTotal.weight_kg + (numericValue(row[key]?.weight_kg) || 0),
      }), { quantity: 0, weight_kg: 0 }),
    }), {});
  });
}

export function calculateMonthlySheet(sheet) {
  const importedArrivals = Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key }) => [
    key,
    (sheet.arrival_sources || []).reduce((total, source) => total + (source.lines || [])
      .filter((line) => line.chemical_key === key)
      .reduce((lineTotal, line) => lineTotal + (numericValue(line.quantity_kg) || 0), 0), 0),
  ]));
  const productionByWeek = productionTotalsByWeek(sheet);
  const blockTotals = Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [
    key,
    productionByWeek.reduce((total, week) => ({
      quantity: total.quantity + week[key].quantity,
      weight_kg: total.weight_kg + week[key].weight_kg,
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
        : remaining <= 0 ? "finished"
          : minimum == null ? "set-minimum"
            : remaining <= minimum ? "reorder" : "ok",
    }];
  }));
  const chemicalUsageByBlock = Object.fromEntries(MONTHLY_SHEET_CHEMICALS.map(({ key: chemicalKey }) => {
    return [chemicalKey, MONTHLY_SHEET_BLOCKS.map(({ key: blockKey, label }) => {
      const quantity = blockTotals[blockKey].quantity;
      const formulaRate = numericValue(sheet.formula_rates?.[blockKey]?.[chemicalKey]);
      return {
        block_key: blockKey,
        block_label: label,
        blocks_produced: quantity,
        formula_rate_kg_per_block: formulaRate,
        used_kg: quantity > 0 && formulaRate == null ? null : quantity * (formulaRate || 0),
        formula_missing: quantity > 0 && formulaRate == null,
      };
    })];
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
      .map((line) => {
        const containerCapacity = numericValue(line.container_capacity);
        const containerCount = numericValue(line.container_count);
        const statedContainerQuantity = containerCapacity * containerCount;
        const totalQuantity = numericValue(line.quantity_kg) ?? statedContainerQuantity;
        return {
          ...line,
          container_capacity: containerCapacity,
          container_count: containerCount,
          total_quantity_kg: totalQuantity,
          container_data_consistent: Math.abs(totalQuantity - statedContainerQuantity) <= 0.0001,
          actually_used_kg: 0,
          usage_by_block: Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [key, 0])),
          depletion_week: null,
        };
      });
    let untrackedConsumption = 0;
    const missingRates = new Set(MONTHLY_SHEET_BLOCKS
      .filter(({ label: blockLabel }) => balance.missingRates.includes(blockLabel))
      .map(({ key: blockKey }) => blockKey));

    if (!missingRates.size) {
      MONTHLY_SHEET_BLOCKS.forEach(({ key: blockKey }) => {
        const usage = chemicalUsageByBlock[chemicalKey]
          .find((item) => item.block_key === blockKey);
        let remainingConsumption = usage.used_kg || 0;
        containers.forEach((container) => {
          if (remainingConsumption <= 0) return;
          const remainingInLot = Math.max(0, container.total_quantity_kg - container.actually_used_kg);
          const allocated = Math.min(remainingConsumption, remainingInLot);
          container.actually_used_kg += allocated;
          container.usage_by_block[blockKey] += allocated;
          remainingConsumption -= allocated;
        });
        untrackedConsumption += remainingConsumption;
      });
    }

    const missingRateLabels = MONTHLY_SHEET_BLOCKS
      .filter(({ key: blockKey }) => missingRates.has(blockKey))
      .map(({ label: blockLabel }) => blockLabel);
    return {
      chemical_key: chemicalKey,
      chemical_label: label,
      usage_by_block: chemicalUsageByBlock[chemicalKey],
      containers: containers.map((container) => {
        const total = container.total_quantity_kg;
        const remaining = Math.max(0, total - container.actually_used_kg);
        return {
          ...container,
          remaining_quantity_kg: remaining,
          empty_container_count: container.container_data_consistent
            ? Math.min(
              container.container_count,
              Math.floor((container.actually_used_kg + 1e-8) / container.container_capacity),
            )
            : null,
          containers_with_stock: container.container_data_consistent
            ? (remaining > 1e-8
              ? Math.min(container.container_count, Math.ceil((remaining - 1e-8) / container.container_capacity))
              : 0)
            : null,
          status: missingRateLabels.length
            ? "missing-formula"
            : !container.container_data_consistent ? "container-data-mismatch"
              : remaining <= 1e-8 ? "empty"
                : container.actually_used_kg > 1e-8 ? "in-use" : "full",
        };
      }),
      missing_rates: missingRateLabels,
      untracked_consumption_kg: missingRateLabels.length ? null : untrackedConsumption,
      tracked_quantity_kg: containers.reduce((sum, container) => sum + container.total_quantity_kg, 0),
      tracked_remaining_kg: containers.reduce((sum, container) =>
        sum + Math.max(0, container.total_quantity_kg - container.actually_used_kg), 0),
    };
  });
  return {
    blockTotals, productionByWeek, totalBlocks, totalBlockWeight, totalArrivals, chemicalBalances, containerTracking,
  };
}

export function calculateDailyProductionReport(sheet, reportDate) {
  if (!reportDate || !reportDate.startsWith(`${sheet.month}-`)) return null;
  const day = sheet.production_days.find((item) => item.date === reportDate);
  if (!day) return null;

  const blocks = MONTHLY_SHEET_BLOCKS.map(({ key, label }) => ({
    key,
    label,
    quantity: numericValue(day[key]?.quantity) || 0,
    weight_kg: numericValue(day[key]?.weight_kg) || 0,
  }));
  const totalBlocks = blocks.reduce((total, block) => total + block.quantity, 0);
  const totalWeightKg = blocks.reduce((total, block) => total + block.weight_kg, 0);
  const chemicalUsage = MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => {
    const byBlock = blocks.map((block) => {
      const formulaRate = numericValue(sheet.formula_rates?.[block.key]?.[key]);
      return {
        block_key: block.key,
        block_label: block.label,
        quantity: block.quantity,
        used_kg: block.quantity > 0 && formulaRate == null
          ? null
          : block.quantity * (formulaRate || 0),
        formula_missing: block.quantity > 0 && formulaRate == null,
      };
    });
    const missingRates = byBlock.filter((item) => item.formula_missing)
      .map((item) => item.block_label);
    return {
      key,
      label,
      byBlock,
      used_today_kg: missingRates.length
        ? null
        : byBlock.reduce((total, item) => total + item.used_kg, 0),
      missingRates,
    };
  });

  const throughDate = {
    ...sheet,
    arrival_sources: (sheet.arrival_sources || []).filter((source) =>
      source.received_date && source.received_date <= reportDate),
    production_days: sheet.production_days.filter((item) => item.date <= reportDate),
    weeks: sheet.weeks.map(() => blankWeek()),
  };
  const cumulative = calculateMonthlySheet(throughDate);
  const balances = MONTHLY_SHEET_CHEMICALS.map(({ key, label }) => {
    const balance = cumulative.chemicalBalances[key];
    const tracking = cumulative.containerTracking.find((item) => item.chemical_key === key);
    const containerCountIsReliable = !tracking.missing_rates.length
      && tracking.containers.every((container) => container.container_data_consistent);
    return {
      key,
      label,
      used_today_kg: chemicalUsage.find((item) => item.key === key).used_today_kg,
      remaining_kg: balance.remaining,
      barrels_remaining: containerCountIsReliable
        ? tracking.containers.reduce((total, container) =>
          total + (container.containers_with_stock || 0), 0)
        : null,
      tracked_remaining_kg: tracking.missing_rates.length ? null : tracking.tracked_remaining_kg,
      missingRates: balance.missingRates,
      hasContainerMismatch: tracking.containers.some((container) =>
        !container.container_data_consistent),
    };
  });

  return {
    date: reportDate,
    blocks,
    totalBlocks,
    totalWeightKg,
    chemicalUsage,
    balances,
    undatedArrivalCount: (sheet.arrival_sources || []).filter((source) =>
      !source.received_date).length,
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
    production_days: (sheet.production_days || []).map((day) => ({
      date: day.date,
      ...Object.fromEntries(MONTHLY_SHEET_BLOCKS.map(({ key }) => [
        key,
        {
          quantity: numberOrNull(day[key].quantity),
          weight_kg: numberOrNull(day[key].weight_kg),
        },
      ])),
    })),
  };
}
