import type {
  CartValidationsGenerateRunInput,
  CartValidationsGenerateRunResult,
  ValidationError,
} from "../generated/api";

type Configuration = {
  status?: string;
  min_subtotal: number;
  gift_variant_id: string;
};

export function cartValidationsGenerateRun(input: CartValidationsGenerateRunInput): CartValidationsGenerateRunResult {
  const configuration = input.shop.metafield?.jsonValue as Configuration | undefined;

  console.log("[GWP validation] config", JSON.stringify(configuration));
  console.log(
    "[GWP validation] lines",
    JSON.stringify(
      input.cart.lines.map((line) => ({
        quantity: line.quantity,
        variantId: line.merchandise.__typename === "ProductVariant" ? line.merchandise.id : null,
        giftMarker: line.giftMarker?.value ?? null,
        amountPerQuantity: line.cost.amountPerQuantity.amount,
      })),
    ),
  );
  console.log("[GWP validation] subtotal", input.cart.cost.subtotalAmount.amount);

  if (!configuration?.gift_variant_id) {
    console.log("[GWP validation] no config set, allowing checkout");
    return { operations: [] };
  }

  // Master switch: missing/older configs default to "active" so existing
  // setups keep working exactly as before this setting existed.
  if (configuration.status === "draft") {
    console.log("[GWP validation] status is draft, allowing checkout");
    return { operations: [] };
  }

  // This offer only applies to US orders in USD - everywhere else, don't
  // enforce anything.
  const isUsInUsd =
    input.localization.country.isoCode === "US" && input.cart.cost.subtotalAmount.currencyCode === "USD";

  if (!isUsInUsd) {
    console.log("[GWP validation] not US/USD, allowing checkout", {
      country: input.localization.country.isoCode,
      currency: input.cart.cost.subtotalAmount.currencyCode,
    });
    return { operations: [] };
  }

  // Count lines matching the gift variant AND carrying the "_gwp_gift"
  // marker, and sum their quantity. This store is on Shopify Plus (see
  // GWP-PLAN.md, "Plus pivot") - the cart-transform function
  // (parks-cart-transformer) clamps the marked line's price to $0 via
  // `lineUpdate`/`linesMerge`, so the gift variant's catalog price is no
  // longer assumed to be $0. That means an UNMARKED line of the same
  // variant is a genuine, normal-price purchase (e.g. the customer buying
  // an extra one for real) and must NOT count against "only one free gift"
  // or the minimum-subtotal gate - counting it would incorrectly block a
  // customer who is paying full price for it.
  //
  // Cart Transform functions run before this one (transform -> discounts ->
  // validation), so by the time this runs, duplicate marked lines have
  // already been folded into a single merged line by `linesMerge` - summing
  // is exactly equivalent to "the one merged line's quantity" in that case,
  // and stays correct as a server-side backstop if that merge (an
  // experimental, unverified-in-production pattern) fails to consolidate
  // anything. This is the layer that can't be bypassed by skipping the
  // storefront or the transform.
  // ...AND that is actually free at this point. The Cart Transform runs
  // BEFORE this function (transform -> discounts -> validation), so the
  // price seen here is the post-transform price: the transform only clamps
  // a marked line to $0 when the offer genuinely applies (active, buyer
  // authenticated - see cart_transform_run.ts). A marked line that is NOT
  // $0 is therefore a line the transform deliberately refused to make
  // free - e.g. it is left over in the cart after the customer logged out.
  //
  // That distinction is essential, not cosmetic: an error emitted here
  // blocks EVERY cart mutation while the condition holds, including the
  // /cart/change.js the storefront script fires to REMOVE that very line.
  // Gating on "actually free" means a leftover, full-price marked line is
  // treated as an ordinary purchase, no error is emitted, and the script's
  // automatic cleanup is free to remove it. Confirmed live: without this
  // gate the cleanup 422s forever and the line can only be removed by hand.
  //
  // NOTE: this assumes the gift variant's catalog price is NOT $0 (see
  // GWP-PLAN.md "Plus pivot" - the whole point of the transform is that we
  // don't depend on that). If a merchant does set it to $0, a leftover
  // marked line looks "free" here and the deadlock returns.
  const isFree = (line: (typeof input.cart.lines)[number]) =>
    parseFloat(line.cost.amountPerQuantity.amount) === 0;

  const giftQuantity = input.cart.lines
    .filter(
      (line) =>
        line.merchandise.__typename === "ProductVariant" &&
        line.merchandise.id === configuration.gift_variant_id &&
        line.giftMarker?.value === "true" &&
        isFree(line),
    )
    .reduce((total, line) => total + line.quantity, 0);

  console.log("[GWP validation] giftQuantity", giftQuantity);

  const errors: ValidationError[] = [];

  if (giftQuantity > 0) {
    // The offer requires a logged-in customer. Anonymous checkout with a
    // marked gift line must be blocked here even though the theme JS
    // already tries not to add the gift in that case - this is the layer
    // that can't be bypassed by skipping the storefront (e.g. the customer
    // logged out after the gift was added, or hit checkout directly).
    if (!input.cart.buyerIdentity?.isAuthenticated) {
      errors.push({
        message: "Please log in to your account to receive the free gift.",
        target: "$.cart",
      });
    }

    const subtotal = parseFloat(input.cart.cost.subtotalAmount.amount);

    if (subtotal < configuration.min_subtotal) {
      errors.push({
        message: `Your order must be at least $${configuration.min_subtotal.toFixed(2)} to qualify for the free gift.`,
        target: "$.cart",
      });
    }
  }

  if (giftQuantity > 1) {
    errors.push({
      message: "Only one free gift is allowed per order.",
      target: "$.cart",
    });
  }

  console.log("[GWP validation] errors", JSON.stringify(errors));

  return {
    operations: [
      {
        validationAdd: {
          errors,
        },
      },
    ],
  };
}
