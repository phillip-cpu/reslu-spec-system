import { PDFDocument } from "pdf-lib";
import { renderToBuffer } from "@react-pdf/renderer";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET } from "@/lib/storage";
import { isSniffedPdf } from "@/lib/file-sniff";
import { reportError } from "@/lib/report-error";
import { DocSeparatorPage, DocsIndexPage, type DocsIndexRow } from "@/components/pdf/DocBundlePages";
import type { ItemFile, ItemFileKind } from "@/types";

/**
 * SERVER-ONLY MODULE. pdf-lib and @react-pdf/renderer both do Node
 * file/Buffer work that has no browser equivalent — this file must
 * only ever be imported from a server context (an API route, same as
 * lib/images.ts and components/pdf/SchedulePdf.tsx already are, both
 * imported exclusively from app/api/projects/[id]/pdf/route.ts). No
 * "server-only" package import here — this codebase doesn't declare
 * that dependency anywhere else either; the existing convention (see
 * lib/images.ts's own header comment) is a doc-comment discipline, not
 * a build-time guard.
 *
 * Print bundle — BUILD-SPEC.md "Export + board batch" item 3: "server
 * merges schedule PDF + each in-scope item's attached spec_sheet/
 * install_manual PDFs into ONE print-ready PDF ... Requires pdf-lib."
 *
 * SEPARATOR PAGE CHOICE (documented per this task's brief — "choose
 * the simpler reliable path and document"): rendered via React-PDF
 * (components/pdf/DocBundlePages.tsx's <DocSeparatorPage>), NOT
 * hand-drawn with pdf-lib's low-level drawText API. Reasoning: this
 * app already has a fully working React-PDF brand style (fonts,
 * palette, layout primitives) shared with SchedulePdf.tsx — reusing it
 * means the separator page automatically gets the same Cormorant/
 * Helvetica fallback behaviour, the same brand palette constants, and
 * the same "never throws on a missing font" resilience, for zero extra
 * code. Hand-drawing the same page with pdf-lib's drawText would mean
 * re-deriving font metrics/kerning/line-wrapping by hand with no
 * layout engine at all — strictly more code and more fragile for a
 * one-page, three-line layout. pdf-lib's OWN job in this module is
 * exactly what it's good at: byte-level PAGE MERGING (copyPages across
 * documents produced by three different renderers — SchedulePdf,
 * DocSeparatorPage/DocsIndexPage, and whatever produced each uploaded
 * spec sheet), not text layout.
 *
 * FUNCTION TIMEOUT AWARENESS: every per-item file fetch below is
 * SEQUENTIAL (same "one bad file never blocks/fails the rest" spirit
 * as lib/images.ts's ensureStoredImagesForItems, and the same
 * sequential-by-design choice BUILD-SPEC.md's brief for this item
 * specifies). vercel.json (protected, not edited by this round) caps
 * this route at maxDuration: 60s already; a project with a LARGE
 * number of attached PDF documents could exceed that budget purely on
 * download+merge time. This is a known limit — see README.md's "PDF
 * bundle size" note for the documented fix (bump this route's
 * maxDuration in vercel.json) rather than a silent change made here.
 */

const MAX_DOC_BYTES = 25 * 1024 * 1024; // 25MB per attached document — generous for a spec sheet/install manual PDF, cheap guard against a runaway download

export interface BundleItemDoc {
  itemId: string;
  itemCode: string | null;
  itemName: string;
  files: ItemFile[];
}

const KIND_LABEL: Record<ItemFileKind, string> = {
  spec_sheet: "Spec sheet",
  install_manual: "Install manual",
  other: "Document",
};

/**
 * Builds the merged print bundle: schedule PDF bytes first, then — in
 * schedule order — each item's attached spec_sheet/install_manual
 * files (PDF ones merged in behind a separator page; non-PDF ones and
 * any that fail to fetch/merge listed on the trailing "Documents
 * index" page instead of blocking the bundle). Never throws — a
 * per-file failure is caught and recorded on the index page; only a
 * catastrophic failure to even load the schedule bytes bubbles up
 * (the caller already has those bytes in hand before calling this, so
 * that's not expected in practice).
 */
export async function buildDocBundle(
  supabase: SupabaseClient,
  scheduleBytes: Uint8Array,
  itemDocs: BundleItemDoc[]
): Promise<Uint8Array> {
  const merged = await PDFDocument.create();
  const indexRows: DocsIndexRow[] = [];

  // ---- 1. Schedule PDF first ----
  try {
    const scheduleDoc = await PDFDocument.load(scheduleBytes);
    const pages = await merged.copyPages(scheduleDoc, scheduleDoc.getPageIndices());
    for (const p of pages) merged.addPage(p);
  } catch (err) {
    // The schedule itself failed to parse back — extremely unlikely
    // (we just rendered it), but never let that crash the whole
    // bundle silently with no record.
    await reportError("pdf-bundle-schedule", err);
  }

  // ---- 2. Per-item documents, in schedule order ----
  for (const doc of itemDocs) {
    for (const file of doc.files) {
      const label = KIND_LABEL[file.kind] ?? "Document";
      try {
        const { data: signed, error: signError } = await supabase.storage
          .from(ASSET_BUCKET)
          .createSignedUrl(file.storage_path, 300); // 5 min — this whole route is short-lived server-side work, never exposed to a browser
        if (signError || !signed?.signedUrl) {
          indexRows.push({
            itemCode: doc.itemCode,
            itemName: doc.itemName,
            note: `${label} — could not be retrieved`,
          });
          continue;
        }

        const res = await fetch(signed.signedUrl);
        if (!res.ok) {
          indexRows.push({
            itemCode: doc.itemCode,
            itemName: doc.itemName,
            note: `${label} — could not be retrieved`,
          });
          continue;
        }
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength === 0 || arrayBuffer.byteLength > MAX_DOC_BYTES) {
          indexRows.push({
            itemCode: doc.itemCode,
            itemName: doc.itemName,
            note: `${label} — could not be retrieved`,
          });
          continue;
        }
        const bytes = Buffer.from(arrayBuffer);

        if (!isSniffedPdf(bytes)) {
          // Non-PDF attachment (image etc.) — listed on the index page
          // rather than merged, per BUILD-SPEC.md item 3.
          indexRows.push({
            itemCode: doc.itemCode,
            itemName: doc.itemName,
            note: `${label} — not printable — view in app`,
          });
          continue;
        }

        // Separator page, then the attached PDF's own pages.
        const separatorBytes = await renderToBuffer(
          DocSeparatorPage({ itemCode: doc.itemCode, itemName: doc.itemName, docLabel: label })
        );
        const separatorDoc = await PDFDocument.load(new Uint8Array(separatorBytes));
        const separatorPages = await merged.copyPages(separatorDoc, separatorDoc.getPageIndices());
        for (const p of separatorPages) merged.addPage(p);

        const attachedDoc = await PDFDocument.load(bytes);
        const attachedPages = await merged.copyPages(attachedDoc, attachedDoc.getPageIndices());
        for (const p of attachedPages) merged.addPage(p);
      } catch (err) {
        await reportError("pdf-bundle-item-doc", err);
        indexRows.push({
          itemCode: doc.itemCode,
          itemName: doc.itemName,
          note: `${label} — could not be retrieved`,
        });
      }
    }
  }

  // ---- 3. Trailing "Documents index" page, only if there's something to list ----
  if (indexRows.length > 0) {
    try {
      const indexBytes = await renderToBuffer(DocsIndexPage({ rows: indexRows }));
      const indexDoc = await PDFDocument.load(new Uint8Array(indexBytes));
      const indexPages = await merged.copyPages(indexDoc, indexDoc.getPageIndices());
      for (const p of indexPages) merged.addPage(p);
    } catch (err) {
      // The bundle still succeeds without its index page rather than
      // failing the whole download — the per-file notes were
      // best-effort informational content, not load-bearing.
      await reportError("pdf-bundle-index", err);
    }
  }

  return merged.save();
}
