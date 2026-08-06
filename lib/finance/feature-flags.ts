export const FINANCE_FOUNDATION_FLAG = "FINANCE_FOUNDATION_ENABLED";
export const FINANCE_SHADOW_FLAG = "FINANCE_SHADOW_PROJECTION_ENABLED";

export function parseServerFeatureFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function financeFoundationEnabled(): boolean {
  return parseServerFeatureFlag(process.env[FINANCE_FOUNDATION_FLAG]);
}

export function financeShadowProjectionEnabled(): boolean {
  return (
    financeFoundationEnabled() &&
    parseServerFeatureFlag(process.env[FINANCE_SHADOW_FLAG])
  );
}
