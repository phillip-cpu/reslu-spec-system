"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { CreateProjectInput } from "@/types";
import type { StandardItemIdsInput } from "@/types/round-d";
import { StandardItemsChecklist } from "@/components/projects/StandardItemsChecklist";

export function ProjectForm() {
  const router = useRouter();
  const [form, setForm] = useState<CreateProjectInput>({
    name: "",
    client_name: "",
    address: "",
    monday_board_id: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Migration 030 round — "Standard spec items" checklist (see
  // components/projects/StandardItemsChecklist.tsx). All-ticked ids,
  // folded into the POST body at submit time.
  const [standardItemIds, setStandardItemIds] = useState<string[]>([]);

  function update<K extends keyof CreateProjectInput>(key: K, value: CreateProjectInput[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const payload: CreateProjectInput & StandardItemIdsInput = {
        ...form,
        standard_item_ids: standardItemIds,
      };
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create project.");
      }

      const { project } = await res.json();
      router.push(`/projects/${project.id}`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-xl space-y-5 bg-offwhite border border-[#dcd6cc] p-8">
      <div>
        <label className="label-caps block mb-2" htmlFor="name">
          Project name
        </label>
        <input
          id="name"
          required
          value={form.name}
          onChange={(e) => update("name", e.target.value)}
          placeholder="e.g. Goldsworthy"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:outline-none focus:border-nearblack"
        />
      </div>

      <div>
        <label className="label-caps block mb-2" htmlFor="client_name">
          Client name
        </label>
        <input
          id="client_name"
          required
          value={form.client_name}
          onChange={(e) => update("client_name", e.target.value)}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:outline-none focus:border-nearblack"
        />
      </div>

      <div>
        <label className="label-caps block mb-2" htmlFor="address">
          Address
        </label>
        <input
          id="address"
          value={form.address}
          onChange={(e) => update("address", e.target.value)}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:outline-none focus:border-nearblack"
        />
      </div>

      <div>
        <label className="label-caps block mb-2" htmlFor="monday_board_id">
          Monday board ID (optional)
        </label>
        <input
          id="monday_board_id"
          value={form.monday_board_id}
          onChange={(e) => update("monday_board_id", e.target.value)}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:outline-none focus:border-nearblack"
        />
      </div>

      <StandardItemsChecklist selectedIds={standardItemIds} onChange={setStandardItemIds} />

      {error && <p className="text-body text-red-700">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="bg-nearblack text-white px-5 py-2.5 text-subhead hover:bg-charcoal transition-colors disabled:opacity-60"
      >
        {submitting ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
