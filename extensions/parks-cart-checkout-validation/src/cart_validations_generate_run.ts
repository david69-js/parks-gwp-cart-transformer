import { BuyerJourneyStep } from "../generated/api";
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

  // Never emit an error while the customer is editing their cart.
  //
  // A validation error does not just warn - it REJECTS the mutation that
  // triggered it. Enforcing during CART_INTERACTION therefore blocks the very
  // requests that would fix the cart: removing the gift line, lowering a
  // quantity, emptying the cart. The customer ends up in a state only we can
  // get them out of, and if the storefront script is not running (app embed
  // off, JS error, a theme that never loads it) nothing gets them out at all.
  //
  // Every previous fix for this attacked one entry point at a time: the
  // storefront retry that rebuilds a blocked change as a combined update, and
  // the "only enforce on lines that are actually free" gate below. Both are
  // still useful, but both are recoveries from a rejection that should never
  // have happened, and both have holes:
  //
  //   - the retry only helps when the request came through fetch (the cart
  //     page's native form POST never reaches it) and only when the blocked
  //     request touched a non-gift line;
  //   - the "actually free" gate depends on the transform refusing to clamp,
  //     which cannot happen when the gift product's CATALOG price is already
  //     $0 - there the line looks free no matter what and the cart deadlocks
  //     permanently (this is the case that prompted this change).
  //
  // Restricting enforcement to the checkout steps closes the whole class
  // instead: the rules still cannot be bypassed (checkout is the only way to
  // turn a cart into an order), but no cart edit is ever refused.
  if (input.buyerJourney.step === BuyerJourneyStep.CartInteraction) {
    console.log("[GWP validation] cart interaction, not enforcing (checkout is where this is enforced)");
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

  // A line we put in the cart, free or not. Used both to count actual gifts
  // (combined with isFree below) and to keep every gift line out of the
  // threshold basis - a gift must never help earn itself.
  const isGiftLine = (line: (typeof input.cart.lines)[number]) =>
    line.merchandise.__typename === "ProductVariant" &&
    line.merchandise.id === configuration.gift_variant_id &&
    line.giftMarker?.value === "true";

  const giftQuantity = input.cart.lines
    .filter((line) => isGiftLine(line) && isFree(line))
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

    // Measure the threshold against what the customer's merchandise costs
    // BEFORE any discount, not against what they end up paying.
    //
    // Functions run transform -> discounts -> validation, so by the time this
    // runs `cart.cost.subtotalAmount` is already net of every discount code.
    // Using it meant a customer who put $100 in the cart and applied a $30
    // code was measured at $70, stopped qualifying, and had their checkout
    // blocked - with the gift already in the cart and no way to fix it from
    // the checkout page. The merchant's rule is "spend $100", and applying a
    // discount does not un-spend it.
    //
    // `CartLineCost.subtotalAmount` is the line's cost before line-level
    // discounts, so summing it across the customer's own lines gives that
    // gross figure. Gift lines are excluded explicitly: their price is
    // whatever the transform decided (usually $0) and they must never count
    // toward the threshold that earns them.
    const qualifyingSubtotal = input.cart.lines
      .filter((line) => !isGiftLine(line))
      .reduce((total, line) => total + parseFloat(line.cost.subtotalAmount.amount), 0);

    // Logged so a live test with a real discount code can confirm which
    // number moved and which did not - `cart.cost.subtotalAmount` should drop
    // by the discount, `qualifyingSubtotal` should not.
    console.log(
      "[GWP validation] threshold basis",
      JSON.stringify({
        qualifyingSubtotal,
        cartSubtotalAfterDiscounts: input.cart.cost.subtotalAmount.amount,
        totalDiscounted: input.cart.lines
          .flatMap((line) => line.discountAllocations)
          .reduce((total, allocation) => total + parseFloat(allocation.discountedAmount.amount), 0),
        minSubtotal: configuration.min_subtotal,
      }),
    );

    if (qualifyingSubtotal < configuration.min_subtotal) {
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
