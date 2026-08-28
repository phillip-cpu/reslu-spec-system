import type { FinanceCreditFacilityType } from "../../types/finance";

export interface CreditFacilityLimit {
  facility_type: FinanceCreditFacilityType;
  credit_limit_minor: number;
  xero_bank_account_type: string;
  xero_balance_minor: number | null;
  xero_balance_source: "bank_summary" | "balance_sheet" | null;
}

function drawnMinor(facility: CreditFacilityLimit): number {
  if (facility.xero_balance_minor === null) return 0;
  if (!Number.isSafeInteger(facility.xero_balance_minor)) {
    throw new Error("Xero facility balance is outside safe minor-unit range");
  }
  return facility.xero_balance_source === "balance_sheet" ||
    facility.xero_bank_account_type.toUpperCase() === "LIABILITY"
    ? Math.max(facility.xero_balance_minor, 0)
    : Math.max(-facility.xero_balance_minor, 0);
}
export function summarizeCreditLiquidity(input: {
  facilities: CreditFacilityLimit[];
}): {
  creditLimitMinor: number;
  creditDrawnMinor: number;
  availableCreditMinor: number;
} {
  const creditLimitMinor = input.facilities.reduce((sum, facility) => {
    if (!Number.isSafeInteger(facility.credit_limit_minor) || facility.credit_limit_minor <= 0) {
      throw new Error("Credit facility limit is outside safe minor-unit range");
    }
    return sum + facility.credit_limit_minor;
  }, 0);
  const creditDrawnMinor = input.facilities.reduce((sum, facility) => {
    return sum + drawnMinor(facility);
  }, 0);
  const availableCreditMinor = input.facilities.reduce((sum, facility) => {
    if (facility.xero_balance_minor === null) return sum;
    const drawn = drawnMinor(facility);
    // Xero Bank Summary cash already includes BANK account overdraft draw, so
    // adding the full limit once yields the correct remaining spending room.
    // CREDITCARD debt is excluded from cash and must reduce the card limit.
    const available = facility.xero_bank_account_type.toUpperCase() === "BANK"
      ? facility.credit_limit_minor
      : Math.max(facility.credit_limit_minor - drawn, 0);
    return sum + available;
  }, 0);
  return {
    creditLimitMinor,
    creditDrawnMinor,
    availableCreditMinor,
  };
}
