const ARGENTINA_TIME_ZONE = "America/Argentina/Buenos_Aires";

type DateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsAt(date: Date): DateParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ARGENTINA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

function offsetMilliseconds(date: Date): number {
  const parts = partsAt(date);
  return (
    Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) -
    date.getTime() +
    date.getUTCMilliseconds()
  );
}

function offsetLabel(offset: number): string {
  const sign = offset >= 0 ? "+" : "-";
  const minutes = Math.abs(offset) / 60_000;
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function parseDate(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new RangeError("La fecha debe tener formato YYYY-MM-DD.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  )
    throw new RangeError("La fecha no existe.");
  return { year, month, day };
}

function argentinaMidnightUtc(date: string): Date {
  const { year, month, day } = parseDate(date);
  const midnightUtc = new Date(Date.UTC(year, month - 1, day));
  return new Date(midnightUtc.getTime() - offsetMilliseconds(midnightUtc));
}

export function toArgentinaIso(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("Instante inválido.");
  const offset = offsetMilliseconds(date);
  const local = new Date(date.getTime() + offset);
  return `${local.getUTCFullYear().toString().padStart(4, "0")}-${String(local.getUTCMonth() + 1).padStart(2, "0")}-${String(local.getUTCDate()).padStart(2, "0")}T${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}:${String(local.getUTCSeconds()).padStart(2, "0")}.${String(local.getUTCMilliseconds()).padStart(3, "0")}${offsetLabel(offset)}`;
}

export function formatArgentinaDateTime(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new RangeError("Instante invÃ¡lido.");
  const { year, month, day, hour, minute } = partsAt(date);
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function argentinaDayStart(date: string): Date {
  return argentinaMidnightUtc(date);
}

export function argentinaDayEndExclusive(date: string): Date {
  const { year, month, day } = parseDate(date);
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));
  const ymd = `${nextDay.getUTCFullYear().toString().padStart(4, "0")}-${String(nextDay.getUTCMonth() + 1).padStart(2, "0")}-${String(nextDay.getUTCDate()).padStart(2, "0")}`;
  return argentinaMidnightUtc(ymd);
}

export function todayInArgentina(now: Date = new Date()): string {
  const { year, month, day } = partsAt(now);
  return `${year.toString().padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
