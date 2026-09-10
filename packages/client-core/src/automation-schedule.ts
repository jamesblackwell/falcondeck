import type { Automation, AutomationTrigger } from "./control";
import type { ScheduledTaskSchedule } from "./types";

const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const DAY_PLURAL = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;
const DAY_ALIAS: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const MONTH_FULL = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTH_ALIAS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};
const RRULE_DAY: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6,
};

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKENDS = [0, 6];

export type ScheduleCadenceInput = {
  trigger?: AutomationTrigger | null;
  resolvedSchedule?: string | null;
  legacySchedule?: ScheduledTaskSchedule | null;
  viewerTimeZone?: string;
};

type CronField = {
  values: number[];
  all: boolean;
};

function joinEnglish(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function sameValues(values: readonly number[], expected: readonly number[]): boolean {
  if (values.length !== expected.length) return false;
  return values.every((value, index) => value === expected[index]);
}

function evenStep(values: readonly number[]): { start: number; step: number } | null {
  if (values.length < 2) return null;
  const step = (values[1] ?? 0) - (values[0] ?? 0);
  if (step <= 0) return null;
  for (let index = 1; index < values.length; index += 1) {
    if ((values[index] ?? 0) - (values[index - 1] ?? 0) !== step) return null;
  }
  return { start: values[0] ?? 0, step };
}

function completeStep(
  values: readonly number[],
  min: number,
  max: number,
): { start: number; step: number } | null {
  const cadence = evenStep(values);
  if (!cadence || cadence.start !== min) return null;
  const last = values.at(-1);
  return last != null && last + cadence.step > max ? cadence : null;
}

function parseNamedValue(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number>,
): number | null {
  const numeric = Number(raw);
  if (Number.isInteger(numeric) && numeric >= min && numeric <= max) return numeric;
  const named = names[raw.toLowerCase()];
  return named == null ? null : named;
}

function parseCronField(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> = {},
): CronField | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "*") return { values: range(min, max), all: true };

  const values = new Set<number>();
  for (const item of trimmed.split(",")) {
    const piece = item.trim();
    if (!piece) return null;
    const [rangePart, stepPart] = piece.split("/", 2);
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
    } else if (rangePart?.includes("-")) {
      const [startRaw, endRaw] = rangePart.split("-", 2);
      const parsedStart = parseNamedValue(startRaw ?? "", min, max, names);
      const parsedEnd = parseNamedValue(endRaw ?? "", min, max, names);
      if (parsedStart == null || parsedEnd == null || parsedStart > parsedEnd) return null;
      start = parsedStart;
      end = parsedEnd;
    } else {
      const value = parseNamedValue(rangePart ?? "", min, max, names);
      if (value == null) return null;
      start = value;
      end = step === 1 ? value : max;
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) return null;
  return { values: [...values].sort((a, b) => a - b), all: false };
}

function range(min: number, max: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max; value += 1) values.push(value);
  return values;
}

function formatClock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function ordinal(value: number): string {
  const remainder = value % 100;
  const suffix =
    remainder >= 11 && remainder <= 13
      ? "th"
      : value % 10 === 1
        ? "st"
        : value % 10 === 2
          ? "nd"
          : value % 10 === 3
            ? "rd"
            : "th";
  return `${value}${suffix}`;
}

function describeTime(minutes: CronField, hours: CronField): string | null {
  if (minutes.all && hours.all) return "Every minute";

  const minuteStep = completeStep(minutes.values, 0, 59);
  if (
    !minutes.all &&
    hours.all &&
    minuteStep &&
    minuteStep.start === 0 &&
    minutes.values.length > 1
  ) {
    return minuteStep.step === 1 ? "Every minute" : `Every ${minuteStep.step} minutes`;
  }

  if (hours.all && minutes.values.length === 1) {
    const minute = minutes.values[0] ?? 0;
    return minute === 0 ? "Every hour" : `Every hour at :${String(minute).padStart(2, "0")}`;
  }

  const hourStep = completeStep(hours.values, 0, 23);
  if (
    !hours.all &&
    hourStep &&
    hourStep.start === 0 &&
    minutes.values.length === 1 &&
    minutes.values[0] === 0 &&
    hours.values.length > 1
  ) {
    return hourStep.step === 1 ? "Every hour" : `Every ${hourStep.step} hours`;
  }

  if (minutes.values.length === 1 && hours.values.length >= 1 && hours.values.length <= 4) {
    const minute = minutes.values[0] ?? 0;
    const times = hours.values.map((hour) => formatClock(hour, minute));
    return `at ${joinEnglish(times)}`;
  }

  if (
    hours.values.length === 1 &&
    minutes.values.length > 1 &&
    minutes.values.length <= 4
  ) {
    const hour = hours.values[0] ?? 0;
    const times = minutes.values.map((minute) => formatClock(hour, minute));
    return `at ${joinEnglish(times)}`;
  }

  if (minuteStep && hours.values.length >= 1 && !minutes.all) {
    const start = hours.values[0] ?? 0;
    const end = hours.values[hours.values.length - 1] ?? start;
    const cadence =
      minuteStep.step === 1 ? "Every minute" : `Every ${minuteStep.step} minutes`;
    if (hours.all) return cadence;
    const contiguousHours = evenStep(hours.values);
    if (contiguousHours && contiguousHours.step === 1 && hours.values.length > 1) {
      return `${cadence} from ${formatClock(start, 0)} to ${formatClock(end, 0)}`;
    }
  }

  return null;
}

function describeDays(
  daysOfMonth: CronField,
  months: CronField,
  daysOfWeek: CronField,
): string | null {
  const monthPhrase = months.all
    ? null
    : months.values.length === 1
      ? MONTH_FULL[(months.values[0] ?? 1) - 1] ?? null
      : months.values.length <= 3
        ? joinEnglish(
            months.values.map((month) => MONTH_FULL[month - 1] ?? `month ${month}`),
          )
        : null;
  if (!months.all && monthPhrase == null) return null;

  const inMonth = monthPhrase ? ` in ${monthPhrase}` : "";

  if (daysOfMonth.all && daysOfWeek.all) {
    return monthPhrase ? `Every day${inMonth}` : "Every day";
  }

  if (daysOfMonth.all && !daysOfWeek.all) {
    if (sameValues(daysOfWeek.values, WEEKDAYS)) return `Weekdays${inMonth}`;
    if (sameValues(daysOfWeek.values, WEEKENDS)) return `Weekends${inMonth}`;
    if (daysOfWeek.values.length === 1) {
      return `${DAY_PLURAL[daysOfWeek.values[0] ?? 0]}${inMonth}`;
    }
    if (daysOfWeek.values.length <= 4) {
      return `${joinEnglish(daysOfWeek.values.map((day) => DAY_SHORT[day] ?? String(day)))}${inMonth}`;
    }
    return null;
  }

  if (!daysOfMonth.all && daysOfWeek.all) {
    if (daysOfMonth.values.length === 1) {
      const day = ordinal(daysOfMonth.values[0] ?? 1);
      return monthPhrase ? `${day} of ${monthPhrase}` : `Monthly on the ${day}`;
    }
    if (daysOfMonth.values.length <= 3) {
      const days = joinEnglish(daysOfMonth.values.map(ordinal));
      return monthPhrase ? `${days} of ${monthPhrase}` : `Monthly on the ${days}`;
    }
  }

  return null;
}

function combineCadence(days: string, time: string): string {
  if (time.startsWith("Every ") && (days === "Every day" || days.startsWith("Every day"))) {
    return days === "Every day" ? time : `${time}, ${days}`;
  }
  if (time.startsWith("at ")) {
    if (days === "Every day") return `Every day ${time}`;
    return `${days} ${time}`;
  }
  if (days === "Every day") return time;
  return `${time}, ${days.charAt(0).toLowerCase()}${days.slice(1)}`;
}

export function formatCronCadence(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const minutes = parseCronField(fields[0] ?? "", 0, 59);
  const hours = parseCronField(fields[1] ?? "", 0, 23);
  const daysOfMonth = parseCronField(fields[2] ?? "", 1, 31);
  const months = parseCronField(fields[3] ?? "", 1, 12, MONTH_ALIAS);
  const daysOfWeek = parseCronField(fields[4] ?? "", 0, 7, DAY_ALIAS);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) return null;
  daysOfWeek.values = [...new Set(daysOfWeek.values.map((day) => (day === 7 ? 0 : day)))].sort(
    (a, b) => a - b,
  );
  if (fields[4] === "*") daysOfWeek.all = true;
  if (fields[2] === "*") daysOfMonth.all = true;

  const time = describeTime(minutes, hours);
  const days = describeDays(daysOfMonth, months, daysOfWeek);
  if (!time || !days) return null;
  return combineCadence(days, time);
}

export function formatTimezoneCity(timeZone: string): string {
  const normalized = timeZone.trim();
  if (!normalized) return normalized;
  if (normalized === "UTC" || normalized === "Etc/UTC" || normalized === "Etc/GMT") {
    return "UTC";
  }
  const leaf = normalized.split("/").at(-1) ?? normalized;
  return leaf.replaceAll("_", " ");
}

function withTimezone(
  cadence: string,
  timeZone: string | null | undefined,
  viewerTimeZone?: string,
): string {
  if (!timeZone) return cadence;
  if (viewerTimeZone && viewerTimeZone === timeZone) return cadence;
  return `${cadence} · ${formatTimezoneCity(timeZone)}`;
}

export function formatIntervalSeconds(everySeconds: number): string {
  if (!Number.isFinite(everySeconds) || everySeconds <= 0) return "On an interval";
  if (everySeconds % 86_400 === 0) {
    const days = everySeconds / 86_400;
    return days === 1 ? "Every day" : `Every ${days} days`;
  }
  if (everySeconds % 3_600 === 0) {
    const hours = everySeconds / 3_600;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  if (everySeconds % 60 === 0) {
    const minutes = everySeconds / 60;
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  return `Every ${everySeconds} seconds`;
}

function formatOnceAt(iso: string, timeZone?: string): string {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return "Once";
  try {
    const formatted = new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      ...(timeZone ? { timeZone } : {}),
    }).format(timestamp);
    return `Once on ${formatted}`;
  } catch {
    return `Once on ${iso}`;
  }
}

function parseRrule(rrule: string): Record<string, string> {
  return Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, "")
      .split(";")
      .flatMap((part) => {
        const [key, value] = part.split("=");
        return key && value ? [[key.toUpperCase(), value]] : [];
      }),
  );
}

function formatLegacyRrule(rrule: string, timeZone?: string, viewerTimeZone?: string): string {
  const rule = parseRrule(rrule);
  const interval = Number(rule.INTERVAL ?? 1) || 1;
  if (rule.FREQ === "MINUTELY") {
    return withTimezone(formatIntervalSeconds(interval * 60), timeZone, viewerTimeZone);
  }
  if (rule.FREQ === "HOURLY") {
    return withTimezone(formatIntervalSeconds(interval * 3_600), timeZone, viewerTimeZone);
  }
  const hour = Number(rule.BYHOUR ?? 9);
  const minute = Number(rule.BYMINUTE ?? 0);
  const time = `at ${formatClock(
    Number.isFinite(hour) ? hour : 9,
    Number.isFinite(minute) ? minute : 0,
  )}`;
  if (rule.FREQ === "WEEKLY") {
    const days = (rule.BYDAY ?? "MO")
      .split(",")
      .map((token) => RRULE_DAY[token.trim().toUpperCase()])
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b);
    const cadence = sameValues(days, WEEKDAYS)
      ? `Weekdays ${time}`
      : sameValues(days, WEEKENDS)
        ? `Weekends ${time}`
        : days.length === 1
          ? `${DAY_PLURAL[days[0] ?? 1]} ${time}`
          : `${joinEnglish(days.map((day) => DAY_SHORT[day] ?? String(day)))} ${time}`;
    return withTimezone(cadence, timeZone, viewerTimeZone);
  }
  return withTimezone(`Every day ${time}`, timeZone, viewerTimeZone);
}

function humanizeResolvedSchedule(
  resolved: string,
  viewerTimeZone?: string,
): string | null {
  const match = /^cron\s+"([^"]+)"\s+\(([^)]+)\)$/i.exec(resolved.trim());
  if (!match) return null;
  const cadence = formatCronCadence(match[1] ?? "");
  if (!cadence) return withTimezone("Custom schedule", match[2], viewerTimeZone);
  return withTimezone(cadence, match[2], viewerTimeZone);
}

export function formatScheduleCadence(input: ScheduleCadenceInput): string {
  const viewerTimeZone = input.viewerTimeZone;
  const trigger = input.trigger;
  if (trigger?.kind === "cron") {
    const cadence = formatCronCadence(trigger.expression);
    if (cadence) return withTimezone(cadence, trigger.timezone, viewerTimeZone);
    return withTimezone("Custom schedule", trigger.timezone, viewerTimeZone);
  }
  if (trigger?.kind === "interval") {
    return formatIntervalSeconds(trigger.every_seconds);
  }
  if (trigger?.kind === "once") {
    return formatOnceAt(trigger.run_at);
  }
  if (input.legacySchedule?.kind === "once") {
    return formatOnceAt(input.legacySchedule.run_at, input.legacySchedule.timezone);
  }
  if (input.legacySchedule?.kind === "recurring") {
    return formatLegacyRrule(
      input.legacySchedule.rrule,
      input.legacySchedule.timezone,
      viewerTimeZone,
    );
  }
  if (input.resolvedSchedule) {
    return humanizeResolvedSchedule(input.resolvedSchedule, viewerTimeZone) ?? input.resolvedSchedule;
  }
  return "Unscheduled";
}

export function formatAutomationCadence(
  automation: Pick<Automation, "trigger" | "resolved_schedule">,
  viewerTimeZone?: string,
): string {
  return formatScheduleCadence({
    trigger: automation.trigger,
    resolvedSchedule: automation.resolved_schedule,
    viewerTimeZone,
  });
}

export type DueAtLabel = {
  label: string;
  overdue: boolean;
  title: string;
};

export function formatDueAt(
  iso: string | null | undefined,
  nowMs: number = Date.now(),
): DueAtLabel | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  let title = iso;
  try {
    title = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(at);
  } catch {
    title = iso;
  }

  const delta = at - nowMs;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (delta < -minute) {
    return { label: "Overdue", overdue: true, title };
  }
  if (delta <= minute) return { label: "Now", overdue: false, title };
  if (delta < hour) {
    const minutes = Math.max(1, Math.round(delta / minute));
    return { label: `in ${minutes}m`, overdue: false, title };
  }
  if (delta < 36 * hour) {
    const hours = Math.round(delta / hour);
    if (hours < 24) return { label: `in ${hours}h`, overdue: false, title };
  }

  const when = new Date(at);
  const now = new Date(nowMs);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfWhen = new Date(
    when.getFullYear(),
    when.getMonth(),
    when.getDate(),
  ).getTime();
  const dayDiff = Math.round((startOfWhen - startOfToday) / day);
  let time = title;
  try {
    time = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(when);
  } catch {
    time = title;
  }
  if (dayDiff === 1) return { label: `tomorrow ${time}`, overdue: false, title };
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(when);
    return { label: `${weekday} ${time}`, overdue: false, title };
  }
  try {
    const date = new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
    }).format(when);
    return { label: date, overdue: false, title };
  } catch {
    return { label: title, overdue: false, title };
  }
}
