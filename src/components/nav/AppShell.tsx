"use client";

import { useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { SidebarNav } from "./SidebarNav";

/**
 * Responsive dashboard frame. Desktop: fixed sidebar. Mobile: top bar + slide-over.
 * Server-rendered pieces (account controls) are passed in as props.
 */
export function AppShell({
  storeName,
  account,
  children,
}: {
  storeName: string;
  account: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const sidebarBody = (
    <div className="flex h-full flex-col gap-6 p-4">
      <div className="px-3 pt-2">
        <p className="text-[11px] font-medium uppercase tracking-wider text-muted">Store</p>
        <p className="mt-0.5 truncate text-base font-semibold">{storeName}</p>
      </div>
      <SidebarNav onNavigate={() => setOpen(false)} />
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-separator px-1 pt-4">
        {account}
      </div>
    </div>
  );

  return (
    <div className="min-h-dvh">
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-separator bg-background/90 px-4 backdrop-blur lg:hidden">
        <p className="truncate text-sm font-semibold">{storeName}</p>
        <button
          type="button"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex size-9 items-center justify-center rounded-lg hover:bg-default"
        >
          {open ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* Mobile slide-over */}
      {open ? (
        <div className="fixed inset-0 top-14 z-20 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-backdrop/50"
            onClick={() => setOpen(false)}
          />
          <aside className="relative h-full w-72 max-w-[85%] border-r border-separator bg-background">
            {sidebarBody}
          </aside>
        </div>
      ) : null}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 hidden w-[var(--app-sidebar-width)] border-r border-separator bg-background lg:block">
        {sidebarBody}
      </aside>

      <main className="lg:pl-[var(--app-sidebar-width)]">
        <div className="mx-auto w-full max-w-6xl p-6">{children}</div>
      </main>
    </div>
  );
}
