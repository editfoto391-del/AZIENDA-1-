export const calculateAttendanceHours = (record) => {
  if (!record?.start_time || !record?.end_time) return { workedHours: 0, overtimeHours: 0 };

  const [startHour, startMinute] = record.start_time.split(":").map(Number);
  const [endHour, endMinute] = record.end_time.split(":").map(Number);
  const duration = ((endHour * 60 + endMinute) - (startHour * 60 + startMinute)) / 60;
  if (!Number.isFinite(duration) || duration <= 0) return { workedHours: 0, overtimeHours: 0 };

  const weekday = new Date(`${record.date}T00:00:00Z`).getUTCDay();
  const isWeekday = weekday >= 1 && weekday <= 5;
  const lunchBreak = isWeekday && duration > 8 ? 1 : 0;
  const endMinutes = endHour * 60 + endMinute;

  return {
    workedHours: Math.max(0, duration - lunchBreak),
    overtimeHours: Math.max(0, (endMinutes - 17 * 60) / 60),
  };
};
