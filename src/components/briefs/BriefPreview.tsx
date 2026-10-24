"use client";

import { useState } from "react";
import { Monitor, Smartphone } from "lucide-react";

/** Sandboxed iframe preview of a template's cached HTML, with a Desktop/Mobile width toggle. */
export function BriefPreview({ html, title }: { html: string | null; title: string }) {
  const [mode, setMode] = useState<"desktop" | "mobile">("desktop");

  if (!html) {
    return (
      <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted">
        No template preview available yet.
      </div>
    );
  }

  const options = [
    { key: "desktop", label: "Desktop", Icon: Monitor },
    { key: "mobile", label: "Mobile", Icon: Smartphone },
  ] as const;

  return (
    <div>
      <div role="group" aria-label="Preview size" className="mb-3 inline-flex rounded-lg bg-default p-0.5">
        {options.map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            aria-pressed={mode === key}
            onClick={() => setMode(key)}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              mode === key ? "bg-surface text-foreground shadow-sm" : "text-muted hover:text-foreground"
            }`}
          >
            <Icon size={14} aria-hidden />
            {label}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-default/40 p-3">
        <iframe
          title={`Email preview: ${title}`}
          srcDoc={html}
          sandbox=""
          loading="lazy"
          style={{ width: mode === "desktop" ? 600 : 375 }}
          className="mx-auto block h-[520px] max-w-full rounded-lg bg-white"
        />
      </div>
    </div>
  );
}
