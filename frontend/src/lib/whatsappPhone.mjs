export const normalizeWhatsAppPhone = (phone) => {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `27${digits.slice(1)}`;
  if (digits.startsWith("270")) digits = `27${digits.slice(3)}`;
  return digits.length >= 7 && digits.length <= 15 ? digits : "";
};

export const resolveWhatsAppPhone = (...phones) => {
  for (const phone of phones) {
    const normalized = normalizeWhatsAppPhone(phone);
    if (normalized) return normalized;
  }
  return "";
};
