"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ItemHit {
  id: string;
  item_code: string;
  name: string;
  category: string;
  location: string | null;
  project_id: string;
  projects: { name: string } | null;
}
interface ProjectHit {
  id: string;
  name: string;
  client_name: string;
  status: string;
}
interface LibraryHit {
  id: string;
  name: string;
  category: string;
  brand: string | null;
  supplier: string | null;
}
interface Results {
  projects: ProjectHit[];
  items: ItemHit[];
  library: LibraryHit[];
}

const EMPTY: Results = { projects: [], items: [], library: [] };

export function SearchClient() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Results>(EMPTY);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(EMPTY);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, {
        signal: ctrl.signal,
      })
        .then((r) => r.json())
        .then((d) => setResults(d))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const total =
    results.projects.length + results.items.length + results.library.length;

  return (
    <div className="max-w-3xl space-y-8">
      <input
        autoFocus
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search projects, items, library…"
        className="w-full border border-[#c9c2b4] bg-nearwhite px-4 py-3 text-subhead focus:border-nearblack focus:outline-none"
      />

      {q.trim().length >= 2 && !loading && total === 0 && (
        <p className="text-body text-charcoal/50">No matches for “{q}”.</p>
      )}

      {results.projects.length > 0 && (
        <section>
          <h2 className="label-caps mb-2 border-b border-nearblack pb-1 !text-nearblack">
            Projects
          </h2>
          <ul className="divide-y divide-[#e5e0d6]">
            {results.projects.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/projects/${p.id}`}
                  className="flex justify-between py-2 hover:bg-nearwhite"
                >
                  <span className="text-body text-nearblack">{p.name}</span>
                  <span className="text-body text-charcoal/50">
                    {p.client_name}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {results.items.length > 0 && (
        <section>
          <h2 className="label-caps mb-2 border-b border-nearblack pb-1 !text-nearblack">
            Items
          </h2>
          <ul className="divide-y divide-[#e5e0d6]">
            {results.items.map((it) => (
              <li key={it.id}>
                <Link
                  href={`/projects/${it.project_id}`}
                  className="flex justify-between gap-3 py-2 hover:bg-nearwhite"
                >
                  <span className="text-body text-nearblack">
                    <span className="label-caps mr-2">{it.item_code}</span>
                    {it.name}
                  </span>
                  <span className="text-body text-charcoal/50">
                    {it.projects?.name}
                    {it.location ? ` · ${it.location}` : ""}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {results.library.length > 0 && (
        <section>
          <h2 className="label-caps mb-2 border-b border-nearblack pb-1 !text-nearblack">
            Library
          </h2>
          <ul className="divide-y divide-[#e5e0d6]">
            {results.library.map((l) => (
              <li key={l.id}>
                <Link
                  href="/library"
                  className="flex justify-between gap-3 py-2 hover:bg-nearwhite"
                >
                  <span className="text-body text-nearblack">
                    <span className="label-caps mr-2">{l.category}</span>
                    {l.name}
                  </span>
                  <span className="text-body text-charcoal/50">
                    {[l.brand, l.supplier].filter(Boolean).join(" · ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
