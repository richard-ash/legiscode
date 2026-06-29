import { useEffect, useState } from "react";
import type { ModuleInfo } from "@/corpus/wire";
import { api } from "@/app/api";

export function ModulesPane() {
  const [modules, setModules] = useState<ModuleInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api()
      .modules.list()
      .then((result) => {
        if (cancelled) return;
        if (result.ok) setModules(result.value);
        else setError(result.error.detail);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load modules");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="lc-modules-error">{error}</div>;
  }

  if (modules === null) {
    return <div className="lc-modules-loading">Loading…</div>;
  }

  if (modules.length === 0) {
    return (
      <div className="lc-modules-empty">
        <p>No law packages are installed.</p>
      </div>
    );
  }

  // Group by jurisdiction for future multi-jurisdiction installs.
  const byJurisdiction = new Map<string, ModuleInfo[]>();
  for (const m of modules) {
    const group = byJurisdiction.get(m.jurisdiction) ?? [];
    group.push(m);
    byJurisdiction.set(m.jurisdiction, group);
  }

  return (
    <div className="lc-modules-list">
      {Array.from(byJurisdiction.entries()).map(([jurisdiction, mods]) => (
        <section key={jurisdiction} className="lc-modules-jurisdiction">
          <h2 className="lc-modules-jurisdiction-title">{jurisdiction}</h2>
          <ul className="lc-modules-entries">
            {mods.map((m) => (
              <li key={m.id} className="lc-modules-entry">
                <span className="lc-modules-entry-name">{m.name}</span>
                <span className="lc-modules-entry-meta">
                  {m.section_count.toLocaleString()} sections · v{m.module_version}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
