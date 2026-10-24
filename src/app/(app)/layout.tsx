import type { ReactNode } from "react";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { AppShell } from "@/components/nav/AppShell";
import { requireStore } from "@/lib/auth";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const { store } = await requireStore();
  return (
    <AppShell
      storeName={store.name}
      account={
        <>
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </>
      }
    >
      {children}
    </AppShell>
  );
}
