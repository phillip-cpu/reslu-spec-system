import type { SupabaseClient } from "@supabase/supabase-js";

export type SystemJobStatus = "succeeded" | "degraded" | "failed";

export interface RecordJobRunInput {
  jobKey: string;
  status: SystemJobStatus;
  startedAt: Date;
  summary?: Record<string, unknown>;
  error?: string | null;
}

/**
 * Best-effort scheduled-job completion logging.
 *
 * Monitoring must never turn a completed business job into a failure,
 * so an unavailable system_job_runs table is reported to the server log
 * and otherwise ignored. Health will correctly age the previous run and
 * alert if this persists.
 */
export async function recordJobRun(
  supabase: SupabaseClient,
  input: RecordJobRunInput
): Promise<void> {
  try {
    const { error } = await supabase.from("system_job_runs").insert({
      job_key: input.jobKey,
      status: input.status,
      started_at: input.startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      summary: input.summary ?? {},
      error: input.error?.slice(0, 2000) || null,
    });
    if (error) console.error("system-job-runs: could not record", input.jobKey, error.message);
  } catch (error) {
    console.error("system-job-runs: unexpected logging failure", input.jobKey, error);
  }
}
