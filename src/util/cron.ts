export type Cron = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
};

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 },
] as const;

function parseNumber(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} has an invalid value "${value}"`);
  }
  return Number(value);
}

function parseField(
  text: string,
  name: string,
  min: number,
  max: number,
): Set<number> {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`${name} has an invalid step`);
    const step = stepText === undefined ? 1 : parseNumber(stepText, name);
    if (step < 1) throw new Error(`${name} step must be at least 1`);
    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [start, end, more] = range.split("-");
      if (more !== undefined) throw new Error(`${name} has an invalid range`);
      from = parseNumber(start, name);
      to = parseNumber(end ?? "", name);
    } else {
      from = parseNumber(range, name);
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) {
      throw new Error(`${name} must be between ${min} and ${max}`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

export function parseCron(expression: string): Cron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      "a cron expression needs 5 fields: minute, hour, day of month, month, day of week",
    );
  }
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = FIELDS.map(
    (field, index) =>
      parseField(fields[index], field.name, field.min, field.max),
  );
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek: new Set([...daysOfWeek].map((day) => day % 7)),
    anyDayOfMonth: fields[2].startsWith("*"),
    anyDayOfWeek: fields[4].startsWith("*"),
  };
}

/** All times are UTC. When both day fields are restricted a date matches if
 * either one does, as in classic cron. */
export function cronMatches(cron: Cron, date: Date): boolean {
  if (
    !cron.minutes.has(date.getUTCMinutes()) ||
    !cron.hours.has(date.getUTCHours()) ||
    !cron.months.has(date.getUTCMonth() + 1)
  ) {
    return false;
  }
  const dayOfMonth = cron.daysOfMonth.has(date.getUTCDate());
  const dayOfWeek = cron.daysOfWeek.has(date.getUTCDay());
  return cron.anyDayOfMonth || cron.anyDayOfWeek
    ? dayOfMonth && dayOfWeek
    : dayOfMonth || dayOfWeek;
}

const SEARCH_MINUTES = 366 * 24 * 60;

export function nextCronRun(cron: Cron, after: Date): Date | undefined {
  let time = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  for (let step = 0; step < SEARCH_MINUTES; step++, time += 60_000) {
    if (cronMatches(cron, new Date(time))) return new Date(time);
  }
}
