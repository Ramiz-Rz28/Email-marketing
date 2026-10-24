import { Alert, Card, Description, Input, Label, TextField } from "@heroui/react";
import { Ban, CalendarClock, ShieldCheck, UserCheck } from "lucide-react";
import { connectShopify } from "@/actions/shopify";
import { updateStoreSettings } from "@/actions/settings";
import { PageHeader } from "@/components/ui/PageHeader";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { ShopifyActions } from "@/components/settings/ShopifyActions";
import { requireStore } from "@/lib/auth";
import { formatDateTime } from "@/lib/format";
import { shopifyConnection } from "@/lib/queries/dashboard";

const ERROR_MESSAGES: Record<string, string> = {
  invalid_shop: "That doesn't look like a valid Shopify store domain. Try your-store.myshopify.com.",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; saved?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const { store } = await requireStore();
  const connection = await shopifyConnection(store.id);
  const error = sp.error ? (ERROR_MESSAGES[sp.error] ?? sp.error.slice(0, 200)) : null;

  return (
    <>
      <PageHeader title="Settings" description="Connect your store, set your brand, and review the safety rules." />

      <div className="max-w-3xl space-y-6">
        {sp.connected === "1" ? (
          <Alert status="success">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Shopify connected</Alert.Title>
              <Alert.Description>We are importing your products, customers and orders now.</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        {sp.saved === "1" ? (
          <Alert status="success">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Settings saved</Alert.Title>
            </Alert.Content>
          </Alert>
        ) : null}
        {error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Something needs attention</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <Card>
          <Card.Header>
            <Card.Title>Shopify</Card.Title>
            <Card.Description>
              {connection
                ? "Your store is connected. Data stays in sync through webhooks."
                : "Connect your store to import customers, orders and products."}
            </Card.Description>
          </Card.Header>
          <Card.Content>
            {connection ? (
              <div className="space-y-5">
                <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Store</dt>
                    <dd className="mt-0.5 break-all font-medium">{connection.shop_domain}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Connected</dt>
                    <dd className="mt-0.5">{formatDateTime(connection.installed_at)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs uppercase tracking-wide text-muted">Last full sync</dt>
                    <dd className="mt-0.5">{connection.last_backfill_at ? formatDateTime(connection.last_backfill_at) : "Not yet"}</dd>
                  </div>
                </dl>
                <ShopifyActions />
              </div>
            ) : (
              <form action={connectShopify} className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <TextField isRequired name="shop" fullWidth className="sm:max-w-sm">
                  <Label>Shop domain</Label>
                  <Input placeholder="your-store.myshopify.com" autoComplete="off" />
                  <Description>The .myshopify.com address, not your public domain.</Description>
                </TextField>
                <SubmitButton>Connect Shopify</SubmitButton>
              </form>
            )}
          </Card.Content>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Brand and sending</Card.Title>
            <Card.Description>Applied to every email template and used as the sender identity.</Card.Description>
          </Card.Header>
          <Card.Content>
            <form action={updateStoreSettings} className="space-y-6">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <TextField isRequired name="name" defaultValue={store.name} fullWidth>
                  <Label>Store name</Label>
                  <Input />
                </TextField>
                <TextField name="brand_logo_url" defaultValue={store.brand_logo_url ?? ""} fullWidth>
                  <Label>Logo URL</Label>
                  <Input type="url" placeholder="https://microsoft.com/logo.png" />
                </TextField>
                <TextField name="brand_primary" defaultValue={store.brand_primary ?? "#111111"} fullWidth>
                  <Label>Primary colour</Label>
                  <Input placeholder="#111111" />
                  <Description>Hex value, used for buttons and accents.</Description>
                </TextField>
                <TextField name="brand_font" defaultValue={store.brand_font ?? ""} fullWidth>
                  <Label>Font stack</Label>
                  <Input placeholder="Inter, Arial, sans-serif" />
                </TextField>
                <TextField name="from_name" defaultValue={store.from_name ?? ""} fullWidth>
                  <Label>From name</Label>
                  <Input placeholder="Your Store" />
                </TextField>
                <TextField name="from_email" type="email" defaultValue={store.from_email ?? ""} fullWidth>
                  <Label>From email</Label>
                  <Input placeholder="hello@microsoft.com" />
                  <Description>Must be on a domain verified with your email provider.</Description>
                </TextField>
                <TextField name="reply_to" type="email" defaultValue={store.reply_to ?? ""} fullWidth>
                  <Label>Reply-to</Label>
                  <Input placeholder="support@microsoft.com" />
                </TextField>
                <TextField name="timezone" defaultValue={store.timezone} fullWidth>
                  <Label>Timezone</Label>
                  <Input placeholder="America/Toronto" />
                  <Description>IANA name. Send windows follow this timezone.</Description>
                </TextField>
                <TextField
                  name="max_emails_per_customer_per_week"
                  type="number"
                  defaultValue={String(store.max_emails_per_customer_per_week)}
                  fullWidth
                >
                  <Label>Max emails per customer per week</Label>
                  <Input min={1} max={14} />
                </TextField>
              </div>
              <SubmitButton variant={connection ? "primary" : "secondary"}>Save settings</SubmitButton>
            </form>
          </Card.Content>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>Guardrails</Card.Title>
            <Card.Description>These rules are enforced by the system and cannot be overridden by the AI.</Card.Description>
          </Card.Header>
          <Card.Content>
            <ul className="space-y-5 text-sm">
              <li className="flex gap-3">
                <UserCheck size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
                <div>
                  <p className="font-medium">Consent first</p>
                  <p className="text-muted">
                    Only customers whose marketing consent is subscribed, with a valid email, can ever receive a campaign.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <Ban size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
                <div>
                  <p className="font-medium">Suppression list</p>
                  <p className="text-muted">
                    Unsubscribes, bounces and spam complaints are suppressed permanently and re-checked at the moment of
                    sending.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <CalendarClock size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
                <div>
                  <p className="font-medium">Frequency cap</p>
                  <p className="text-muted">
                    No customer receives more than {store.max_emails_per_customer_per_week} marketing{" "}
                    {store.max_emails_per_customer_per_week === 1 ? "email" : "emails"} per week, across all campaigns.
                  </p>
                </div>
              </li>
              <li className="flex gap-3">
                <ShieldCheck size={18} className="mt-0.5 shrink-0 text-success" aria-hidden />
                <div>
                  <p className="font-medium">Human approval</p>
                  <p className="text-muted">
                    Every AI-planned campaign waits for your approval. Approvals and sends are recorded in the audit log.
                  </p>
                </div>
              </li>
            </ul>
          </Card.Content>
        </Card>
      </div>
    </>
  );
}
