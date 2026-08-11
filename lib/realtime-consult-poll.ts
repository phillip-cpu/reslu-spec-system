export function realtimeConsultPollDelay(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return 250;
  if (elapsedMs < 5_000) return 250;
  if (elapsedMs < 15_000) return 500;
  return 1_000;
}
