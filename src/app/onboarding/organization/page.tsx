import { OrganizationList } from "@clerk/nextjs";

/** One Clerk Organization == one merchant store. Users must pick/create one. */
export default function Page() {
  return (
    <main className="min-h-dvh grid place-items-center p-6">
      <OrganizationList hidePersonal afterSelectOrganizationUrl="/overview" afterCreateOrganizationUrl="/overview" />
    </main>
  );
}
