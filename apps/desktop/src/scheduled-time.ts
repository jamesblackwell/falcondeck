function wallTimeParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function utcToWallTime(instant: Date, timezone: string) {
  const parts = wallTimeParts(instant, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** Resolves a user-entered wall clock through an explicit IANA timezone. */
export function wallTimeToUtc(value: string, timezone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("Choose a valid date and time");
  const target = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let instant = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = wallTimeParts(new Date(instant), timezone);
    const rendered = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    );
    instant += target - rendered;
  }
  if (utcToWallTime(new Date(instant), timezone) !== value) {
    throw new Error(`That wall time does not exist in ${timezone}`);
  }
  return new Date(instant).toISOString();
}
