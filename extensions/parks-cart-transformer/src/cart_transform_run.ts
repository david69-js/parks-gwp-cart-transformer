import type {
  CartTransformRunInput,
  CartTransformRunResult,
} from "../generated/api";

const NO_CHANGES: CartTransformRunResult = {
  operations: [],
};

type Configuration = {
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
const GIFT_MARKER_ATTRIBUTE = {key: "_gwp_gift", value: "true"};
const GIFT_MESSAGE_ATTRIBUTE = {key: "Gift", value: "Free Gift With Purchase"};

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

  // Match on merchandise id only (not a line property) - a customer can
  // reach the gift variant's own product page and add it "for real", and
  // any such line needs to be price-clamped/folded too, same as the
  // validation function's enforcement.
  const giftLines = input.cart.lines.filter(
    (line) => line.merchandise.__typename === "ProductVariant" && line.merchandise.id === configuration.gift_variant_id,
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
          attributes: [GIFT_MARKER_ATTRIBUTE, GIFT_MESSAGE_ATTRIBUTE],
        },
      },
    ],
  };
}
