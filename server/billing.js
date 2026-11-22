// Billing: phase 2. Nothing here talks to Stripe yet; this file documents the intended flow and holds
// the one hook the app already calls (billingPortal). No Stripe code, keys or SDK in phase 1.
//
// Decided for phase 2: restaurants sign up on their own, start a free trial, and pay by card through
// Stripe, charged automatically every month (plans and prices: server/platform/plans.js).
//
// ---------------------------------------------------------------------------------------------------
// The intended flow
//
// 1. Sign-up (public page, e.g. https://<PLATFORM_DOMAIN>/signup)
//      POST /api/signup { restaurant name, slug, owner name, email, plan }
//        → createTenant() in server/platform/onboard.js, the same function the platform console uses,
//          with status 'trialing' and trial_ends_at = now + TRIAL_DAYS (plans.js), and no admin actor.
//          It checks the slug (server/platform/slugs.js), creates the schema and the owner, and emails
//          the owner the set-your-password link.
//        → Stripe Checkout (mode: 'subscription', the plan's price from stripePriceFor(plan),
//          subscription_data.trial_period_days or trial_end, client_reference_id = tenant id,
//          customer_email = owner). Store billing.stripeCustomerId when Checkout completes.
//      Rate-limit it and add a CAPTCHA (or Stripe Checkout first, tenant after) so bots can't create schemas.
//
// 2. Webhooks: POST /api/billing/webhook (raw body, verify the Stripe-Signature header with
//    STRIPE_WEBHOOK_SECRET; idempotent by event id), mounted at the platform level (server/platform/index.js)
//    like the cron, not inside a restaurant's app.
//      checkout.session.completed      → billing.stripeCustomerId, billing.subscriptionId
//      customer.subscription.created / updated
//                                      → billing.status, billing.priceId, billing.currentPeriodEnd,
//                                        billing.cancelAtPeriodEnd; plan = planForPrice(priceId);
//                                        status: trialing → 'trialing', active → 'active',
//                                        past_due / unpaid → 'past_due'
//      customer.subscription.deleted   → status 'canceled' (the data is kept; reactivating is a new subscription)
//      invoice.payment_failed          → status 'past_due' (the admins' banner: "Payment failed, update your card")
//      invoice.paid                    → status 'active'
//    Every change goes through registry.updateTenant() and registry.audit({ action: 'billing.<event>' }),
//    so it shows up in the platform console's audit log, and every instance picks it up within seconds.
//    Decide how long past_due lasts before 'suspended' (Stripe's Smart Retries settings).
//
// 3. Customer portal: the admins' billing banner (trial ending, payment failed) has a button that POSTs
//    /api/billing/portal (server/app.js). Phase 2 makes billingPortal() below create a Stripe Billing Portal
//    session for billing.stripeCustomerId with return_url = the restaurant's Settings page, and the app
//    opens session.url. Until then it returns null and the app tells the admin to contact DubLow Digital.
//
// Env for phase 2 (not used yet): STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO.
// ---------------------------------------------------------------------------------------------------

/** The billing fields every restaurant has (platform.tenants.billing). Filled by the webhooks in phase 2. */
export const EMPTY_BILLING = Object.freeze({
  stripeCustomerId: null,
  subscriptionId: null,
  priceId: null,
  status: null, // Stripe's subscription status
  currentPeriodEnd: null, // ISO time
  cancelAtPeriodEnd: false,
});

/** Keep only the billing fields above. */
export function cleanBilling(raw = {}) {
  const out = { ...EMPTY_BILLING };
  for (const k of Object.keys(EMPTY_BILLING)) if (raw && k in raw) out[k] = raw[k];
  return out;
}

/** Is billing (Stripe) set up on this deployment? Always false in phase 1. */
export const billingEnabled = () => false;

/**
 * Where the billing banner's button goes: phase 2 returns { url } of a Stripe Billing Portal session.
 * @param {object} o
 * @param {object|null} o.tenant     the restaurant (server/app.js's tenant option)
 * @param {string} o.returnUrl       where Stripe sends the admin back to
 * @returns {Promise<{ url: string } | null>}
 */
export async function billingPortal({ tenant, returnUrl }) { // eslint-disable-line no-unused-vars
  return null; // phase 2: stripe.billingPortal.sessions.create({ customer: tenant.billing.stripeCustomerId, return_url: returnUrl })
}
