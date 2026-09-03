const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Converts an Australian DD/MM editor value to stored MM-DD; undefined means invalid. */
export function birthdayFromInput(input: string): string | null | undefined {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(trimmed);
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const date = new Date(Date.UTC(2000, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function birthdayInputValue(value: string | null | undefined): string {
  if (!value) return "";
  const [month, day] = value.split("-");
  return month && day ? `${Number(day)}/${Number(month)}` : "";
}

export function birthdayLabel(value: string): string {
  const [monthText, dayText] = value.split("-");
  const month = Number(monthText);
  const day = Number(dayText);
  if (!MONTH_NAMES[month - 1] || !day) return value;
  return `${day} ${MONTH_NAMES[month - 1]}`;
}

export function isValidStoredBirthday(value: string | null | undefined): boolean {
  if (value == null || value === "") return true;
  const match = /^(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const date = new Date(Date.UTC(2000, month - 1, day));
  return date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function birthdayMatchesDate(value: string | null | undefined, dateOnly: string): boolean {
  return Boolean(value && value === dateOnly.slice(5));
}
