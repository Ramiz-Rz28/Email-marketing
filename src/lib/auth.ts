import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getStoreByOrg, upsertStoreForOrg, type StoreRow } from "./db";

/**
 * Resolve the current merchant store from the active Clerk Organization.
 * One Clerk org == one store. Call from server components, server actions,
 * and route handlers under /(app).
 */
export async function requireStore(): Promise<{ store: StoreRow; userId: string; orgId: string }> {
  const { userId, orgId, orgSlug } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/onboarding/organization");

  let store = await getStoreByOrg(orgId);
  if (!store) {
    const user = await currentUser();
    const name = orgSlug ?? user?.firstName ?? "My Store";
    store = await upsertStoreForOrg(orgId, name);
  }
  return { store, userId, orgId };
}

/** Non-redirecting variant for API routes. */
export async function getStoreOrNull(): Promise<{ store: StoreRow; userId: string } | null> {
  const { userId, orgId } = await auth();
  if (!userId || !orgId) return null;
  const store = await getStoreByOrg(orgId);
  return store ? { store, userId } : null;
}
