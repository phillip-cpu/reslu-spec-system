"use client";

import { useState } from "react";
import { XERO_REPORTS, xeroReportDefinition } from "@/lib/xero/report-definitions";
import type {
  XeroConnectionStatus,
  XeroReport,
  XeroReportKey,
  XeroReportResult,
  XeroReportRow,
} from "@/types/xero";

const NOTICE: Record<string, string> = {
  connected: "Xero connected successfully.",
  invalid_state: "The Xero sign-in expired or could not be verified. Please try again.",
  tenant_selection_required:
    "More than one Xero organisation is authorised. Set XERO_TENANT_ID to the RESLU tenant, then connect again.",
  connection_failed: "Xero could not be connected. Check the server logs and app credentials.",
};

function formatDate(value: string | null): string {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function dateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function defaultFinancialYearStart(): string {
  const now = new Date();
  const year = now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear();
  return `${year}-07-01`;
}

interface FlatReportRow {
  row: XeroReportRow;
  depth: number;
}

function flattenReportRows(rows: XeroReportRow[] = [], depth = 0): FlatReportRow[] {
  return rows.flatMap((row) => [
    { row, depth },
    ...flattenReportRows(row.Rows, depth + 1),
  ]);
}

function csvCell(value: string | undefined): string {
  return `"${(value ?? "").replaceAll('"', '""')}"`;
}

function reportCsv(result: XeroReportResult): string {
  const lines: string[] = [];
  for (const report of result.reports) {
    lines.push(csvCell(report.ReportName ?? result.label));
    for (const title of report.ReportTitles ?? []) lines.push(csvCell(title));
    if (report.ReportDate) lines.push(csvCell(report.ReportDate));
    for (const { row, depth } of flattenReportRows(report.Rows)) {
      if (row.Title && !row.Cells?.length) {
        lines.push(csvCell(`${"  ".repeat(depth)}${row.Title}`));
      } else {
        lines.push((row.Cells ?? []).map((cell, index) =>
          csvCell(index === 0 ? `${"  ".repeat(depth)}${cell.Value ?? ""}` : cell.Value)
        ).join(","));
      }
    }
    for (const field of report.Fields ?? []) {
      lines.push([csvCell(field.Description ?? field.FieldID), csvCell(field.Value)].join(","));
    }
    lines.push("");
  }
  return lines.join("\r\n");
}

function ReportView({ report }: { report: XeroReport }) {
  const rows = flattenReportRows(report.Rows);
  return (
    <div className="mt-4 overflow-hidden border border-[#dcd6cc] bg-white">
      <div className="border-b border-[#e5e0d6] px-3 py-3">
        <h4 className="text-subhead text-nearblack">{report.ReportName ?? "Xero report"}</h4>
        {(report.ReportTitles ?? []).slice(1).map((title) => (
          <p key={title} className="text-caption text-charcoal/55">{title}</p>
        ))}
        {report.ReportDate && <p className="text-caption text-charcoal/55">{report.ReportDate}</p>}
      </div>
      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full border-collapse text-caption">
            <tbody>
              {rows.map(({ row, depth }, index) => (
                <tr
                  key={`${row.RowType ?? "row"}-${index}`}
                  className={row.RowType === "SummaryRow" ? "bg-[#f3f0e9] font-medium" : "border-b border-[#eee9df]"}
                >
                  {row.Title && !row.Cells?.length ? (
                    <th colSpan={12} className="px-3 py-2 text-left text-nearblack" style={{ paddingLeft: 12 + depth * 14 }}>
                      {row.Title}
                    </th>
                  ) : (
                    (row.Cells ?? []).map((cell, cellIndex) => (
                      <td
                        key={cellIndex}
                        className={`whitespace-nowrap px-3 py-2 ${cellIndex === 0 ? "text-left text-nearblack" : "text-right text-charcoal"}`}
                        style={cellIndex === 0 ? { paddingLeft: 12 + depth * 14 } : undefined}
                      >
                        {cell.Value ?? ""}
                      </td>
                    ))
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(report.Fields?.length ?? 0) > 0 && (
        <dl className="grid gap-x-6 gap-y-2 px-3 py-3 text-caption sm:grid-cols-2">
          {report.Fields?.map((field, index) => (
            <div key={`${field.FieldID ?? "field"}-${index}`}>
              <dt className="text-charcoal/55">{field.Description ?? field.FieldID}</dt>
              <dd className="text-nearblack">{field.Value || "—"}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function XeroIntegrationSettings({
  initialStatus,
  callbackUrl,
  notice,
}: {
  initialStatus: XeroConnectionStatus;
  callbackUrl: string;
  notice?: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState<string | null>(notice ? NOTICE[notice] ?? null : null);
  const [reportKey, setReportKey] = useState<XeroReportKey>("profit_and_loss");
  const [fromDate, setFromDate] = useState(defaultFinancialYearStart);
  const [toDate, setToDate] = useState(() => dateInputValue(new Date()));
  const [asAtDate, setAsAtDate] = useState(() => dateInputValue(new Date()));
  const [reportLoading, setReportLoading] = useState(false);
  const [reportResult, setReportResult] = useState<XeroReportResult | null>(null);
  const selectedReport = xeroReportDefinition(reportKey) ?? XERO_REPORTS[0];

  async function syncNow() {
    setSyncing(true);
    setMessage(null);
    try {
      const response = await fetch("/api/xero/sync", { method: "POST" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Xero sync failed");
      setStatus(body.status as XeroConnectionStatus);
      setMessage(
        `Xero sync complete: ${body.result.invoices_checked} invoices and ${body.result.payments_checked} payments checked.`
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Xero sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function pullReport() {
    setReportLoading(true);
    setMessage(null);
    setReportResult(null);
    try {
      const response = await fetch("/api/xero/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          report: reportKey,
          ...(selectedReport.dateMode === "period" ? { fromDate, toDate } : {}),
          ...(selectedReport.dateMode === "as_at" ? { date: asAtDate } : {}),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Xero report failed");
      setReportResult(body.result as XeroReportResult);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Xero report failed");
    } finally {
      setReportLoading(false);
    }
  }

  function downloadReport() {
    if (!reportResult) return;
    const blob = new Blob([reportCsv(reportResult)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `xero-${reportResult.key}-${reportResult.retrieved_at.slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="max-w-2xl border border-[#dcd6cc] bg-offwhite">
      <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-4">
        <div>
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`h-2.5 w-2.5 ${status.connected ? "bg-emerald-600" : "bg-charcoal/25"}`}
            />
            <h3 className="text-body text-nearblack">Xero accounting</h3>
          </div>
          <p className="mt-1 text-caption text-charcoal/55">
            Read-only invoices, purchase bills, payments and financial reports.
          </p>
        </div>
        {status.configured && !status.connected && (
          <a
            href="/api/xero/connect"
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal"
          >
            Connect Xero
          </a>
        )}
        {status.connected && (
          <button
            type="button"
            onClick={syncNow}
            disabled={syncing}
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-50"
          >
            {syncing ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>

      {!status.configured ? (
        <div className="border-t border-[#e5e0d6] px-4 py-4 text-body text-charcoal/65">
          <p>Server credentials are not configured yet.</p>
          <p className="mt-2 text-caption">
            Create the Xero OAuth app with callback URL <code>{callbackUrl}</code>, then add the
            Xero environment variables in Vercel.
          </p>
        </div>
      ) : status.connected ? (
        <>
        <dl className="grid gap-4 border-t border-[#e5e0d6] px-4 py-4 text-body sm:grid-cols-2">
          <div>
            <dt className="label-caps !text-charcoal/50">Organisation</dt>
            <dd className="mt-1 text-nearblack">{status.tenant_name}</dd>
          </div>
          <div>
            <dt className="label-caps !text-charcoal/50">Last sync</dt>
            <dd className="mt-1 text-nearblack">{formatDate(status.last_sync_completed_at)}</dd>
          </div>
          <div>
            <dt className="label-caps !text-charcoal/50">Cached records</dt>
            <dd className="mt-1 text-nearblack">
              {status.invoice_count} invoices · {status.payment_count} payments
            </dd>
          </div>
          <div>
            <dt className="label-caps !text-charcoal/50">Access</dt>
            <dd className="mt-1 text-nearblack">Read only</dd>
          </div>
        </dl>
        <div className="border-t border-[#e5e0d6] px-4 py-4">
          <div>
            <h4 className="text-subhead text-nearblack">Pull a Xero report</h4>
            <p className="mt-1 text-caption text-charcoal/55">
              Live from Xero. Reports are displayed here and are not editable.
            </p>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-caption text-charcoal/65">
              Report
              <select
                value={reportKey}
                onChange={(event) => setReportKey(event.target.value as XeroReportKey)}
                className="mt-1 w-full border border-[#cfc8bc] bg-white px-3 py-2 text-body text-nearblack"
              >
                {XERO_REPORTS.map((report) => (
                  <option key={report.key} value={report.key}>{report.label}</option>
                ))}
              </select>
            </label>
            {selectedReport.dateMode === "period" && (
              <div className="grid grid-cols-2 gap-2">
                <label className="text-caption text-charcoal/65">
                  From
                  <input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} className="mt-1 w-full border border-[#cfc8bc] bg-white px-2 py-2 text-body text-nearblack" />
                </label>
                <label className="text-caption text-charcoal/65">
                  To
                  <input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} className="mt-1 w-full border border-[#cfc8bc] bg-white px-2 py-2 text-body text-nearblack" />
                </label>
              </div>
            )}
            {selectedReport.dateMode === "as_at" && (
              <label className="text-caption text-charcoal/65">
                As at
                <input type="date" value={asAtDate} onChange={(event) => setAsAtDate(event.target.value)} className="mt-1 w-full border border-[#cfc8bc] bg-white px-3 py-2 text-body text-nearblack" />
              </label>
            )}
          </div>
          <button
            type="button"
            onClick={pullReport}
            disabled={reportLoading}
            className="mt-3 bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-50"
          >
            {reportLoading ? "Pulling report…" : "Pull report"}
          </button>
          {reportResult && (
            <div className="mt-4">
              <button
                type="button"
                onClick={downloadReport}
                className="border border-[#cfc8bc] bg-white px-3 py-2 text-caption text-nearblack hover:bg-[#f3f0e9]"
              >
                Download CSV
              </button>
              {reportResult.reports.length > 0 ? reportResult.reports.map((report, index) => (
                <ReportView key={`${report.ReportID ?? report.ReportName ?? "report"}-${index}`} report={report} />
              )) : (
                <p className="text-caption text-charcoal/60">Xero returned no published reports for this selection.</p>
              )}
            </div>
          )}
        </div>
        </>
      ) : (
        <p className="border-t border-[#e5e0d6] px-4 py-4 text-body text-charcoal/60">
          Credentials are configured. Authorise the RESLU Xero organisation to begin.
        </p>
      )}

      {(message || status.last_sync_error) && (
        <p className="border-t border-[#e5e0d6] px-4 py-3 text-caption text-charcoal/65">
          {message ?? status.last_sync_error}
        </p>
      )}
    </div>
  );
}
