import type { FinanceCreditFacilityType } from "../../types/finance";

export interface CreditFacilityLimit {
  facility_type: FinanceCreditFacilityType;
  credit_limit_minor: number;
  xero_bank_account_type: string;
  xero_balance_minor: number;
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
    if (!Number.isSafeInteger(facility.xero_balance_minor)) {
      throw new Error("Xero facility balance is outside safe minor-unit range");
    }
    return sum + Math.max(-facility.xero_balance_minor, 0);
  }, 0);
  const availableCreditMinor = input.facilities.reduce((sum, facility) => {
    const drawnMinor = Math.max(-facility.xero_balance_minor, 0);
    // Xero Bank Summary cash already includes BANK account overdraft draw, so
    // adding the full limit once yields the correct remaining spending room.
    // CREDITCARD debt is excluded from cash and must reduce the card limit.
    const available = facility.xero_bank_account_type.toUpperCase() === "CREDITCARD"
      ? Math.max(facility.credit_limit_minor - drawnMinor, 0)
      : facility.credit_limit_minor;
    return sum + available;
  }, 0);
  return {
    creditLimitMinor,
    creditDrawnMinor,
    availableCreditMinor,
  };
}
