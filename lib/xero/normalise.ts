type XeroRecord = Record<string, unknown>;

export function xeroDate(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const iso = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (iso) return iso;
  const milliseconds = value.match(/\/Date\((\d+)/)?.[1];
  return milliseconds ? new Date(Number(milliseconds)).toISOString().slice(0, 10) : null;
}

export function xeroTimestamp(record: XeroRecord): string | null {
  const direct = record.UpdatedDateUTCString;
  if (typeof direct === "string" && direct) return new Date(direct).toISOString();
  const legacy = record.UpdatedDateUTC;
  if (typeof legacy !== "string") return null;
  const milliseconds = legacy.match(/\/Date\((\d+)/)?.[1];
  return milliseconds ? new Date(Number(milliseconds)).toISOString() : null;
}
