import type { FinanceCreditFacilityType } from "../../types/finance";

export interface CreditFacilityLimit {
  facility_type: FinanceCreditFacilityType;
  credit_limit_minor: number;
}
export function summarizeCreditLiquidity(input: {
  facilities: CreditFacilityLimit[];
  xeroCreditBalanceDollars: number | string | null | undefined;
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
  const cardLimitMinor = input.facilities
    .filter((facility) => facility.facility_type === "credit_card")
    .reduce((sum, facility) => sum + facility.credit_limit_minor, 0);
  const xeroBalance = Number(input.xeroCreditBalanceDollars ?? 0);
  if (!Number.isFinite(xeroBalance)) throw new Error("Xero credit balance is invalid");
  const creditDrawnMinor = Math.max(-Math.round(xeroBalance * 100), 0);
  const bankFacilityLimitMinor = creditLimitMinor - cardLimitMinor;
  return {
    creditLimitMinor,
    creditDrawnMinor,
    // Overdraft/LOC draw is already included in Xero bank cash. Card debt is
    // excluded from bank cash, so only it is deducted from card limits here.
    availableCreditMinor:
      bankFacilityLimitMinor + Math.max(cardLimitMinor - creditDrawnMinor, 0),
  };
}
