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

  // Count EVERY line matching the gift variant, marked or not, and sum
  // their quantity. This is intentionally NOT rewritten to "read the
  // quantity of the one merged line" even though the cart-transform
  // function (parks-cart-transformer) now merges duplicate gift lines into
  // one via `linesMerge` - that merge is an experimental, unverified-in-
  // production pattern (see GWP-PLAN.md). Summing across all matching lines
  // is exactly equivalent to "the single merged line's quantity" when the
  // merge succeeds, but stays correct as a server-side backstop even if the
  // merge silently fails to consolidate anything. This is the layer that
  // can't be bypassed by skipping the storefront or the transform.
  const giftQuantity = input.cart.lines
    .filter(
      (line) => line.merchandise.__typename === "ProductVariant" && line.merchandise.id === configuration.gift_variant_id,
    )
    .reduce((total, line) => total + line.quantity, 0);

  console.log("[GWP validation] giftQuantity", giftQuantity);

  const errors: ValidationError[] = [];

  if (giftQuantity > 0) {
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
