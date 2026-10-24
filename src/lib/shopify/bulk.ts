import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { adminGraphql } from "../shopify";

export type BulkKind = "products" | "customers" | "orders";

/** The slice of shopify_connections needed to call the Admin API. */
export type ShopifyConn = { shop_domain: string; access_token: string; scopes: string };

export type BulkStatus =
  | "CREATED"
  | "RUNNING"
  | "COMPLETED"
  | "CANCELING"
  | "CANCELED"
  | "FAILED"
  | "EXPIRED"
  | string;

type UserError = { field?: string[] | null; message: string };

/** Run an Admin GraphQL operation and return `data`, throwing on top-level errors. */
export async function gql<T>(conn: ShopifyConn, query: string, variables?: Record<string, unknown>): Promise<T> {
  const client = adminGraphql(conn.shop_domain, conn.access_token, conn.scopes);
  const res = await client.request<T>(query, variables ? { variables } : undefined);
  if (res.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(res.errors.graphQLErrors ?? res.errors.message ?? res.errors)}`);
  }
  if (!res.data) throw new Error("Shopify GraphQL returned no data");
  return res.data as T;
}

function ordersSince(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/** Inner queries handed to bulkOperationRunQuery. */
function innerQuery(kind: BulkKind): string {
  switch (kind) {
    case "products":
      return `{
  products {
    edges { node {
      id handle title productType vendor tags status onlineStoreUrl
      featuredImage { url }
      priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
    } }
  }
}`;
    case "customers":
      return `{
  customers {
    edges { node {
      id createdAt firstName lastName tags numberOfOrders
      amountSpent { amount currencyCode }
      defaultEmailAddress { emailAddress marketingState marketingOptInLevel marketingUpdatedAt }
    } }
  }
}`;
    case "orders":
      return `{
  orders(query: "processed_at:>=${ordersSince(2)}") {
    edges { node {
      id name createdAt processedAt cancelledAt displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { id email firstName lastName }
      lineItems {
        edges { node {
          id title quantity
          product { id }
          variant { id }
          originalUnitPriceSet { shopMoney { amount currencyCode } }
        } }
      }
    } }
  }
}`;
  }
}

const RUN_MUTATION = `
mutation RunBulk($query: String!) {
  bulkOperationRunQuery(query: $query) {
    bulkOperation { id status }
    userErrors { field message }
  }
}`;

/** Start a bulk export for one resource kind. Returns the bulk operation gid. */
export async function startBulkQuery(conn: ShopifyConn, kind: BulkKind): Promise<{ id: string; status: BulkStatus }> {
  const data = await gql<{
    bulkOperationRunQuery: { bulkOperation: { id: string; status: string } | null; userErrors: UserError[] };
  }>(conn, RUN_MUTATION, { query: innerQuery(kind) });
  const r = data.bulkOperationRunQuery;
  if (r.userErrors?.length || !r.bulkOperation) {
    throw new Error(`bulkOperationRunQuery(${kind}) failed: ${r.userErrors?.map((e) => e.message).join("; ") || "no operation"}`);
  }
  return r.bulkOperation;
}

const POLL_QUERY = `
query BulkOp($id: ID!) {
  node(id: $id) {
    ... on BulkOperation { id status errorCode objectCount url partialDataUrl }
  }
}`;

export type BulkPoll = {
  id: string;
  status: BulkStatus;
  url: string | null;
  errorCode: string | null;
  objectCount: string | null;
};

/** Poll a specific bulk operation (several can run concurrently on recent API versions). */
export async function pollBulkOperation(conn: ShopifyConn, bulkOperationId: string): Promise<BulkPoll> {
  const data = await gql<{
    node: { id: string; status: string; errorCode?: string | null; objectCount?: string; url?: string | null } | null;
  }>(conn, POLL_QUERY, { id: bulkOperationId });
  if (!data.node) throw new Error(`Bulk operation ${bulkOperationId} not found`);
  return {
    id: data.node.id,
    status: data.node.status,
    url: data.node.url ?? null,
    errorCode: data.node.errorCode ?? null,
    objectCount: data.node.objectCount ?? null,
  };
}

export type JsonlRow = Record<string, unknown> & { __children?: Record<string, unknown>[] };

/**
 * Stream a bulk-operation JSONL file line by line. Child rows (those with `__parentId`)
 * are attached to the preceding parent under `__children`; Shopify guarantees children
 * directly follow their parent, so memory stays O(one parent).
 */
export async function* downloadJsonl(url: string): AsyncGenerator<JsonlRow> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Bulk download failed: HTTP ${res.status}`);
  const rl = createInterface({
    input: Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
    crlfDelay: Infinity,
  });

  let current: JsonlRow | null = null;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const row = JSON.parse(trimmed) as Record<string, unknown>;
    const parentId = row.__parentId;
    if (typeof parentId === "string" && current && current.id === parentId) {
      (current.__children ??= []).push(row);
      continue;
    }
    if (current) yield current;
    current = row;
  }
  if (current) yield current;
}
