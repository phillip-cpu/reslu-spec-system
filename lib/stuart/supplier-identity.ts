const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19] as const;

export function normalizeAustralianAbn(value: string): string {
  return value.replace(/\D/g, "");
}

export function isValidAustralianAbn(value: string): boolean {
  const digits = normalizeAustralianAbn(value);
  if (!/^\d{11}$/.test(digits)) return false;
  const checksum = [...digits].reduce((sum, digit, index) => {
    const adjusted = Number(digit) - (index === 0 ? 1 : 0);
    return sum + adjusted * ABN_WEIGHTS[index];
  }, 0);
  return checksum % 89 === 0;
}
