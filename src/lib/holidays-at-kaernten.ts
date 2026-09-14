// Gregorian Easter (Meeus/Jones/Butcher), calendar dates without timezone shifts.
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function shiftCalendarDate(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function austrianHolidays(year: number): Set<string> {
  const easter = easterSunday(year);
  return new Set([
    ...["01-01", "01-06", "05-01", "08-15", "10-10", "10-26", "11-01", "12-08", "12-25", "12-26"].map((day) => `${year}-${day}`),
    ...[1, 39, 50, 60].map((days) => shiftCalendarDate(easter, days)),
  ]);
}

const holidayCache = new Map<number, Set<string>>();
export function isWorkingDay(date?: string): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const value = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== date) return false;
  const day = value.getUTCDay();
  if (day === 0 || day === 6) return false;
  const year = value.getUTCFullYear();
  if (!holidayCache.has(year)) holidayCache.set(year, austrianHolidays(year));
  return !holidayCache.get(year)!.has(date);
}

// Only actual clock values, never infer noon from a date-only statement.
export function statementTime(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    const match = value?.match(/(?:^|[\sT,;])(\d{1,2}):([0-5]\d)(?::([0-5]\d)(?:[.:]\d{1,3})?)?(?:\s*(AM|PM))?(?=$|[\sZ+),;])/i);
    if (!match) continue;
    let hour = Number(match[1]);
    if (match[4]) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (match[4].toUpperCase() === "PM" ? 12 : 0);
    }
    if (hour > 23) continue;
    return `${String(hour).padStart(2, "0")}:${match[2]}:${match[3] ?? "00"}`;
  }
}

export function isLunchTime(date?: string, time?: string): boolean {
  const clock = statementTime(time);
  return isWorkingDay(date) && !!clock && clock >= "11:00:00" && clock <= "14:00:00";
}
