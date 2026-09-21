/** Recommended /v1/track names and example properties, available before the first event.
 * These are conventions, not an ingestion allowlist or automatically emitted events.
 * Keep existing custom event names unchanged: matching is exact and case-sensitive.
 */
export const STANDARD_EVENTS = [
  { name: "sign_up", properties: { method: "email" } },
  { name: "login", properties: { method: "email" } },
  { name: "purchase_completed", properties: { order_id: "order_123", total_amount: 29000, currency: "KRW", item_count: 1 } },
  { name: "product_viewed", properties: { product_id: "product_123", price: 29000, currency: "KRW" } },
  { name: "add_to_cart", properties: { product_id: "product_123", quantity: 1, price: 29000, currency: "KRW" } },
  { name: "checkout_started", properties: { cart_id: "cart_123", item_count: 1, total_amount: 29000, currency: "KRW" } },
] as const;

export type StandardEventName = (typeof STANDARD_EVENTS)[number]["name"];
