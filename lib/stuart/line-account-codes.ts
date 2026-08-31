export interface LineAccountCodeInput {
  line_sort: number;
  account_code: string;
}

export interface SourceLineRef {
  sort: number;
}

const ACCOUNT_CODE = /^\d{3,10}$/;

function validAccountCode(value: string | undefined): value is string {
  return typeof value === "string" && ACCOUNT_CODE.test(value.trim());
}

export function resolveLineAccountCodes(
  sourceLines: SourceLineRef[],
  accountCode?: string,
  requestedMappings?: LineAccountCodeInput[],
) {
  const mappings = requestedMappings ?? [];
  if (accountCode && mappings.length > 0) {
    throw new Error("Provide either one account code or a line-by-line account mapping, not both");
  }

  if (sourceLines.length === 0) {
    if (mappings.length > 0) throw new Error("Line account codes require verified supplier invoice lines");
    if (!validAccountCode(accountCode)) throw new Error("A valid Xero expense account code is required");
    return {
      accountCodeBySort: new Map<number, string>(),
      auditAccountCode: accountCode.trim(),
      auditMappings: [] as LineAccountCodeInput[],
      fallbackAccountCode: accountCode.trim(),
    };
  }

  if (mappings.length === 0) {
    if (!validAccountCode(accountCode)) throw new Error("A valid Xero expense account code is required");
    const normalized = accountCode.trim();
    const auditMappings = sourceLines.map((line) => ({ line_sort: line.sort, account_code: normalized }));
    return {
      accountCodeBySort: new Map(auditMappings.map((item) => [item.line_sort, item.account_code])),
      auditAccountCode: normalized,
      auditMappings,
      fallbackAccountCode: normalized,
    };
  }

  const sourceSorts = new Set(sourceLines.map((line) => line.sort));
  const mappingSorts = new Set<number>();
  const normalizedMappings = mappings.map((mapping) => {
    if (!Number.isInteger(mapping.line_sort) || mapping.line_sort < 0 || !sourceSorts.has(mapping.line_sort)) {
      throw new Error("Every line account mapping must reference an existing supplier source-line sort");
    }
    if (mappingSorts.has(mapping.line_sort)) throw new Error("Each supplier source line must have exactly one account code");
    if (!validAccountCode(mapping.account_code)) throw new Error("Every supplier source line requires a valid Xero account code");
    mappingSorts.add(mapping.line_sort);
    return { line_sort: mapping.line_sort, account_code: mapping.account_code.trim() };
  });
  if (mappingSorts.size !== sourceSorts.size) throw new Error("Every supplier source line must have exactly one account code");

  const uniqueCodes = [...new Set(normalizedMappings.map((mapping) => mapping.account_code))].sort();
  return {
    accountCodeBySort: new Map(normalizedMappings.map((item) => [item.line_sort, item.account_code])),
    auditAccountCode: uniqueCodes.join(","),
    auditMappings: normalizedMappings.sort((a, b) => a.line_sort - b.line_sort),
    fallbackAccountCode: null,
  };
}
