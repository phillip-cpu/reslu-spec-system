# Workroom routines research

## Product standard

The Routines view is an operations surface, not a decorative list of cron expressions. A routine must distinguish configuration (it is scheduled) from execution evidence (it actually ran), make failures diagnosable, and keep consequential controls governed.

## Patterns reviewed

- [Apache Airflow UI](https://airflow.apache.org/docs/apache-airflow/stable/ui.html): list rows expose schedule, next run, latest state, recent-run history, owner/tags and pause state; detail views separate overview, runs, logs and metadata.
- [Vercel cron management](https://vercel.com/docs/cron-jobs/manage-cron-jobs): cron invocations are function calls; logs are the source of execution evidence; duplicate delivery and overlapping runs are possible, so idempotency and locking matter. Individual schedule changes are deployment configuration, while Vercel's UI disable control affects cron jobs globally.
- [GitHub Actions monitoring](https://docs.github.com/en/actions/how-tos/monitor-workflows): run status, run history and drill-down logs are distinct layers; failed runs expose the failed step before offering a rerun.
- [Prefect schedule management](https://docs.prefect.io/v3/how-to-guides/deployments/manage-schedules): pause/resume and manual runs are explicit scheduler actions rather than incidental card interactions.

## Applied to RESLU

1. The routine list shows owner, human cadence, next Adelaide run, latest observed run and a compact recent-run signal.
2. Opening a routine explains its business purpose, endpoint, UTC definition, monitoring key, last success, recent duration/outcome history and latest error.
3. Search, owner and health filters support normal operational triage.
4. A routine without immutable `system_job_runs` evidence is labelled **Not reporting**. The UI never equates “present in `vercel.json`” with “healthy.”
5. Manual-run and pause controls are deliberately not improvised. These can send messages, mutate records or interrupt all Vercel cron jobs, so they require per-routine authority, idempotency and an audit receipt before they belong in Workroom.

## Remaining observability work

Four current routine endpoints already write immutable job-run evidence. The Routines view identifies the remaining endpoints as monitoring gaps. Each should adopt `recordJobRun` with a stable job key, run status, duration, safe outcome counts and error text; once added, Workroom will display the history automatically after its path-to-key mapping is registered.
