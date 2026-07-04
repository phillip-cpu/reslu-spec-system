"use client";

import { useState } from "react";
import type { CreateLeadInput, LeadSource } from "@/types";

/**
 * Add-lead composer — BUILD-SPEC.md "Add-lead composer (name, first
 * name, source, email/phone/location, values)". A single small form,
 * not a full-page route, mirroring the "Add column"/"Add card" inline
 * composer pattern in components/board/ProjectBoard.tsx.
 */
export function AddLeadComposer({
  onCreate,
  onClose,
}: {
  onCreate: (input: CreateLeadInput) => Promise<void>;
  onClose: () => void;
}) {
  const [surnameProject, setSurnameProject] = useState("");
  const [firstName, setFirstName] = useState("");
  const [source, setSource] = useState<LeadSource | "">("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState("");
  const [constructionValue, setConstructionValue] = useState("");
  const [designValue, setDesignValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!surnameProject.trim()) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onCreate({
        surname_project: surnameProject.trim(),
        first_name: firstName.trim() || null,
        source: source || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        location: location.trim() || null,
        construction_value: constructionValue ? Number(constructionValue) : null,
        design_value: designValue ? Number(designValue) : null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create lead.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4"
    >
      <p className="label-caps !text-charcoal/50">New lead</p>

      {error && <p className="text-body text-red-700">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">Name / project *</span>
          <input
            autoFocus
            value={surnameProject}
            onChange={(e) => setSurnameProject(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">First name</span>
          <input
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">Source</span>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as LeadSource | "")}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="">—</option>
            <option value="META">META</option>
            <option value="DIRECT">DIRECT</option>
          </select>
        </label>
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">Location</span>
          <input
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">Phone</span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">Construction value ($)</span>
          <input
            type="number"
            min="0"
            step="1000"
            value={constructionValue}
            onChange={(e) => setConstructionValue(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <span className="label-caps mb-1 block !text-charcoal/50">Design value ($)</span>
          <input
            type="number"
            min="0"
            step="500"
            value={designValue}
            onChange={(e) => setDesignValue(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="bg-nearblack px-4 py-2 text-caption text-white hover:bg-charcoal disabled:opacity-50"
        >
          {saving ? "Adding…" : "Add lead"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="border border-[#c9c2b4] px-4 py-2 text-caption text-charcoal hover:border-nearblack"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
