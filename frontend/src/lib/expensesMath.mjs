export const EXPENSE_DESCRIPTION_SUGGESTIONS = [
  "Vehicle expense",
  "Diesel",
  "Commission",
];

const COMMON_EXPENSE_CORRECTIONS = new Map([
  ["veichle", "vehicle"],
  ["deisel", "diesel"],
  ["commision", "commission"],
]);

export function correctCommonExpenseTypos(value) {
  return String(value || "").replace(/\bveichle\b|\bdeisel\b|\bcommision\b/gi, (word) => {
    const corrected = COMMON_EXPENSE_CORRECTIONS.get(word.toLocaleLowerCase());
    if (word === word.toLocaleUpperCase()) return corrected.toLocaleUpperCase();
    if (word[0] === word[0].toLocaleUpperCase()) {
      return corrected[0].toLocaleUpperCase() + corrected.slice(1);
    }
    return corrected;
  });
}

export function filterExpenseRows(expenses, fleetCosts, filters, currentDate) {
  const { category = "", destinationCity = "", month = "", date = "", search = "" } = filters;
  const currentMonth = currentDate.slice(0, 7);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const matches = (expense, isFleet = false) => {
    const expenseDate = String(expense.date || "");
    const expenseCity = String(expense.destination_city || "");
    return (!category || expense.category === category)
      && (!destinationCity || (!isFleet && expenseCity.trim().toLocaleLowerCase() === destinationCity.toLocaleLowerCase()))
      && (!month || (expenseDate.startsWith(month) && (month !== currentMonth || expenseDate.slice(0, 10) <= currentDate)))
      && (!date || expenseDate.startsWith(date))
      && (!normalizedSearch || `${expense.description || ""} ${expense.reference || ""} ${expenseCity}`.toLocaleLowerCase().includes(normalizedSearch));
  };
  const seenExpenseIds = new Set();
  const regularExpenses = (expenses || []).filter((expense) => {
    if (!matches(expense)) return false;
    if (!expense.id) return true;
    if (seenExpenseIds.has(expense.id)) return false;
    seenExpenseIds.add(expense.id);
    return true;
  });
  const completedFleetCosts = (fleetCosts || [])
    .filter((expense) => expense.source === "fleet" && matches(expense, true))
    .map((expense) => ({ ...expense, source: "vehicle_record", source_label: "Completed fleet cost" }));
  return [...regularExpenses, ...completedFleetCosts]
    .sort((left, right) => String(right.date || "").localeCompare(String(left.date || "")));
}

export function sumExpenseRows(rows) {
  const cents = (rows || []).reduce((total, row) => {
    const amount = Number(row.amount);
    return total + (Number.isFinite(amount) ? Math.round(amount * 100) : 0);
  }, 0);
  return cents / 100;
}
