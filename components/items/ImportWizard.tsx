"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import readXlsxFile from "read-excel-file/browser";
import {
  parseCsvTable,
  rowsToCsv,
  suggestColumnMapping,
  IMPORT_TARGET_FIELDS,
  IMPORT_FIELD_LABELS,
  type ImportTargetField,
} from "@/lib/csv";
import type { ImportItemsResponse } from "@/types";

type Step = "upload" | "map" | "done";

interface Props {
  projectId: string;
}

export function ImportWizard({ projectId }: Props) {
  const [step, setStep] = useState<Step>("upload");
  const [csvText, setCsvText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<Record<string, ImportTargetField | "">>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportItemsResponse | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  function loadCsv(text: string, name: string) {
    setError(null);
    const { headers: h, rows: r } = parseCsvTable(text);
    if (h.length === 0) {
      setError("Could not find a header row in that file.");
      return;
    }
    if (r.length === 0) {
      setError("That file has a header row but no data rows.");
      return;
    }
    const suggested = suggestColumnMapping(h);
    const initial: Record<string, ImportTargetField | ""> = {};
    for (const header of h) initial[header] = suggested[header] ?? "";

    setCsvText(text);
    setFileName(name);
    setHeaders(h);
    setRows(r);
    setMapping(initial);
    setStep("map");
  }

  function onFilePicked(file: File) {
    setError(null);
    const isXlsx =
      file.name.toLowerCase().endsWith(".xlsx") ||
      file.type ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

    if (isXlsx) {
      // read-excel-file/browser returns Sheet[] = [{sheet, data}] (data is
      // the 2D cell grid). Take the first sheet's rows, serialise to CSV,
      // and hand it to the same loadCsv pipeline — the server is unchanged.
      // (Guard for a plain Row[] too, in case a build returns rows directly.)
      readXlsxFile(file)
        .then((parsed) => {
          const arr = parsed as unknown as Array<
            | { data?: (string | number | boolean | Date | null)[][] }
            | (string | number | boolean | Date | null)[]
          >;
          const first = arr[0];
          const grid = Array.isArray(first)
            ? (arr as (string | number | boolean | Date | null)[][])
            : (first as { data?: (string | number | boolean | Date | null)[][] })?.data ?? [];
          if (grid.length === 0) {
            setError("That spreadsheet has no sheets or no rows.");
            return;
          }
          loadCsv(rowsToCsv(grid), file.name);
        })
        .catch((err) =>
          setError(
            `Could not read that spreadsheet (${
              err instanceof Error ? err.message : "unknown error"
            }). Make sure it's a .xlsx file — not .xls, .numbers, or a protected/corrupt workbook.`
          )
        );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => loadCsv(String(reader.result ?? ""), file.name);
    reader.onerror = () => setError("Could not read that file.");
    reader.readAsText(file);
  }

  const mappedCount = useMemo(
    () => Object.values(mapping).filter((v) => v !== "").length,
    [mapping]
  );
  const nameIsMapped = useMemo(
    () => Object.values(mapping).includes("name") || Object.values(mapping).includes("description"),
    [mapping]
  );
  const categoryOrCodeMapped = useMemo(
    () => Object.values(mapping).includes("category") || Object.values(mapping).includes("item_code"),
    [mapping]
  );

  async function submitImport() {
    setSubmitting(true);
    setError(null);
    try {
      const cleanMapping: Record<string, string | null> = {};
      for (const header of headers) {
        cleanMapping[header] = mapping[header] || null;
      }
      const res = await fetch(`/api/projects/${projectId}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ csv: csvText, mapping: cleanMapping }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Import failed.");
      setResult(body as ImportItemsResponse);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      {step === "upload" && (
        <div className="space-y-4 border border-[#dcd6cc] bg-offwhite p-8 text-center">
          <p className="text-subhead text-nearblack">Upload a CSV export</p>
          <p className="mx-auto max-w-md text-body text-charcoal/60">
            Programa-style exports work best (Code, Type/Item, Product Name,
            Brand, Colour, Material, Finish, dimensions, Supplier, Location,
            Qty, Category). You&apos;ll confirm how columns map before anything
            is created.
          </p>
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onFilePicked(f);
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            className="bg-nearblack px-5 py-2.5 text-subhead text-white transition-colors hover:bg-charcoal"
          >
            Choose CSV or Excel file
          </button>
        </div>
      )}

      {step === "map" && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-body text-charcoal/60">
              {fileName} · {rows.length} row{rows.length === 1 ? "" : "s"} ·{" "}
              {mappedCount}/{headers.length} columns mapped
            </p>
            <button
              type="button"
              onClick={() => setStep("upload")}
              className="text-caption text-charcoal/50 underline decoration-charcoal/30 underline-offset-2 hover:text-nearblack"
            >
              Choose a different file
            </button>
          </div>

          {!nameIsMapped && (
            <p className="border border-sand/50 bg-offwhite px-3 py-2 text-caption text-charcoal/70">
              Map at least one column to Name or Description — every item needs a name.
            </p>
          )}
          {!categoryOrCodeMapped && (
            <p className="border border-sand/50 bg-offwhite px-3 py-2 text-caption text-charcoal/70">
              Map a Category column, or an Item code column (e.g. &quot;TW-01&quot;) so
              the category can be derived from its prefix.
            </p>
          )}

          <div className="overflow-x-auto border border-[#dcd6cc]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-[#dcd6cc] bg-offwhite">
                  <th className="label-caps px-3 py-2">CSV column</th>
                  <th className="label-caps px-3 py-2">Maps to</th>
                  <th className="label-caps px-3 py-2">Sample value</th>
                </tr>
              </thead>
              <tbody>
                {headers.map((header, colIdx) => (
                  <tr key={header} className="border-b border-[#e5e0d6]">
                    <td className="px-3 py-2 text-body text-nearblack">{header}</td>
                    <td className="px-3 py-2">
                      <select
                        value={mapping[header] ?? ""}
                        onChange={(e) =>
                          setMapping((cur) => ({
                            ...cur,
                            [header]: e.target.value as ImportTargetField | "",
                          }))
                        }
                        className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
                      >
                        <option value="">Don&apos;t import</option>
                        {IMPORT_TARGET_FIELDS.map((f) => (
                          <option key={f} value={f}>
                            {IMPORT_FIELD_LABELS[f]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="max-w-xs truncate px-3 py-2 text-caption text-charcoal/50">
                      {rows[0]?.[colIdx] || <span className="text-charcoal/25">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={submitting || !nameIsMapped || !categoryOrCodeMapped}
              onClick={submitImport}
              className="bg-nearblack px-5 py-2.5 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-50"
            >
              {submitting ? "Importing…" : `Import ${rows.length} row${rows.length === 1 ? "" : "s"}`}
            </button>
            <p className="text-caption text-charcoal/40">
              Rows whose item code already exists in this project are skipped, not overwritten.
            </p>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-6 border border-[#dcd6cc] bg-offwhite p-6">
            <Stat label="Created" value={result.created} />
            <Stat label="Skipped (duplicates)" value={result.skipped} />
            <Stat label="Errors" value={result.errors} />
          </div>

          {result.results.some((r) => r.status !== "created") && (
            <div className="overflow-x-auto border border-[#dcd6cc]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="border-b border-[#dcd6cc] bg-offwhite">
                    <th className="label-caps px-3 py-2">Row</th>
                    <th className="label-caps px-3 py-2">Code</th>
                    <th className="label-caps px-3 py-2">Name</th>
                    <th className="label-caps px-3 py-2">Status</th>
                    <th className="label-caps px-3 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.results
                    .filter((r) => r.status !== "created")
                    .map((r) => (
                      <tr key={r.row} className="border-b border-[#e5e0d6]">
                        <td className="px-3 py-2 text-body">{r.row}</td>
                        <td className="px-3 py-2 text-body">{r.item_code || "—"}</td>
                        <td className="px-3 py-2 text-body">{r.name || "—"}</td>
                        <td className="px-3 py-2 text-body capitalize">
                          {r.status.replace("_", " ")}
                        </td>
                        <td className="px-3 py-2 text-caption text-charcoal/60">
                          {r.reason ?? "—"}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Link
              href={`/projects/${projectId}`}
              className="bg-nearblack px-5 py-2.5 text-subhead text-white transition-colors hover:bg-charcoal"
            >
              Go to spec register
            </Link>
            <button
              type="button"
              onClick={() => {
                setStep("upload");
                setResult(null);
                setCsvText("");
                setFileName(null);
                setHeaders([]);
                setRows([]);
                setMapping({});
              }}
              className="border border-nearblack px-5 py-2.5 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
            >
              Import another file
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="label-caps mb-1">{label}</p>
      <p className="text-section font-display text-nearblack">{value}</p>
    </div>
  );
}
