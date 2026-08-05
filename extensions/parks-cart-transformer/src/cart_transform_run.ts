import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

type Configuration = {
  status?: string;
  gift_variant_id: string;
};

// This shop is on Shopify Plus, so `lineUpdate`/price-adjusted `linesMerge`
// operations are allowed - see GWP-PLAN.md ("Plus pivot"). DO NOT re-enable
// these if this app is ever installed on a non-Plus store: `lineUpdate`
// (price/title/image overrides) requires Shopify Plus, and attempting one on
// a non-Plus store produces a hard cart calculation error that blocks the
// ENTIRE cart (not a silent no-op) - that's what took down the earlier
// attempt at this function, before this store's plan was confirmed.

// Attributes copied onto the merged line so it keeps showing as a gift in
// the cart UI after consolidation, matching what the storefront script sets
// via cart/add.js properties when it first adds the line.
// Marker only, matching what the storefront script sets via cart/add.js. The
// visible `Gift: "Free Gift With Purchase"` attribute was dropped: it survived
// on lines this function later refuses to make free, so checkout showed a
// "free gift" label next to a real charge. The theme renders that label
// itself now, conditioned on the line actually being $0.
const GIFT_MARKER_ATTRIBUTE = {key: "_gwp_gift", value: "true"};

// EXPERIMENTAL / UNVERIFIED IN PRODUCTION: every published Shopify example of
// `linesMerge` merges DIFFERENT component variants into a dedicated "bundle"
// parent variant. Using the gift variant as its own `parentVariantId` (to
// fold its own duplicate lines into one) is not a documented or confirmed
// pattern. This must be verified live (`shopify app dev` against a real
// cart: add the gift variant twice with different line properties so they
// don't natively coalesce, confirm it collapses into a single $0 line)
// before this can be trusted in production. If live testing shows this
// doesn't work, this function should go back to only doing the single-line
// `lineUpdate` price clamp below, and duplicate-line handling should move
// back to the storefront script.
export function cartTransformRun(input: CartTransformRunInput): CartTransformRunResult {
  const configuration = input.shop.metafield?.jsonValue as Configuration | undefined;

  console.log("[GWP transform] config", JSON.stringify(configuration));

  if (!configuration?.gift_variant_id) {
    console.log("[GWP transform] no config set, doing nothing");
    return NO_CHANGES;
  }

  // status "draft" = the merchant turned GWP off from the admin action. The
  // gift variant must go back to behaving like a normal product: if for any
  // reason a marked line still exists (e.g. the theme JS hasn't cleaned it
  // up yet, or the app embed is off), it must not keep getting clamped to
  // $0 forever with no other protection active (the validation function
  // also turns itself off in draft - see GWP-PLAN.md).
  if (configuration.status === "draft") {
    console.log("[GWP transform] status draft, doing nothing");
    return NO_CHANGES;
  }

  // The offer requires a logged-in customer (see GWP-PLAN.md). If a marked
  // gift line somehow exists on an anonymous cart (e.g. the customer logged
  // out mid-session before the theme JS's next sync), it must not stay
  // clamped to $0 - the validation function also blocks checkout for this
  // same case, so leaving it here would be the only enforcement layer left
  // active, same reasoning as the draft-status check above.
  if (!input.cart.buyerIdentity?.isAuthenticated) {
    console.log("[GWP transform] buyer not authenticated, doing nothing");
    return NO_CHANGES;
  }

  // Match on merchandise id AND the "_gwp_gift" marker property. Unlike the
  // old (pre-Plus) design, the gift variant's catalog price is no longer
  // assumed to be $0 - only the auto-added, marked line should be free. A
  // customer who separately adds more of the same variant "for real" (no
  // marker - e.g. from its own product page) gets a completely untouched
  // line at its normal catalog price; it must NOT be folded into the free
  // line or have its price clamped. The validation function applies the
  // same marker filter for the same reason - see GWP-PLAN.md ("marker
  // pivot").
  const giftLines = input.cart.lines.filter(
    (line) =>
      line.merchandise.__typename === "ProductVariant" &&
      line.merchandise.id === configuration.gift_variant_id &&
      line.giftMarker?.value === "true",
  );

  console.log(
    "[GWP transform] giftLines",
    JSON.stringify(giftLines.map((line) => ({id: line.id, quantity: line.quantity}))),
  );

  if (giftLines.length === 0) {
    console.log("[GWP transform] no gift lines, nothing to do");
    return NO_CHANGES;
  }

  if (giftLines.length === 1) {
    // Single line, nothing to consolidate - just clamp its price to $0.
    console.log("[GWP transform] one gift line, clamping price to $0", giftLines[0].id);
    return {
      operations: [
        {
          lineUpdate: {
            cartLineId: giftLines[0].id,
            price: {adjustment: {fixedPricePerUnit: {amount: "0.00"}}},
          },
        },
      ],
    };
  }

  // 2+ lines: fold into one AND zero the price in the SAME operation.
  // Deliberately NOT a separate `lineUpdate` alongside the `linesMerge` on
  // the same original line - Shopify has a documented-but-currently-broken
  // interaction where an `update` and a `merge` targeting the same cart line
  // in one function result silently drops the update
  // (https://github.com/Shopify/function-examples/issues/470). Using
  // `linesMerge`'s own `price` field (a 100% decrease) avoids that
  // combination entirely: it's one operation, not two stacked on one line.
  // The exact numeric convention for `percentageDecrease.value` (0-100 vs a
  // fraction) isn't documented with a worked example either - "100.0" here
  // assumes the same 0-100 scale used by Shopify's Discount Function APIs.
  // Verify live alongside the merge behavior itself.
  console.log("[GWP transform] merging duplicate gift lines and zeroing price", giftLines.length);

  return {
    operations: [
      {
        linesMerge: {
          parentVariantId: configuration.gift_variant_id,
          cartLines: giftLines.map((line) => ({
            cartLineId: line.id,
            quantity: line.quantity,
          })),
          price: {percentageDecrease: {value: "100.0"}},
          attributes: [GIFT_MARKER_ATTRIBUTE],
        },
      },
    ],
  };
}
