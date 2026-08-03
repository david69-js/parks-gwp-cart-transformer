import "@shopify/ui-extensions/preact";
import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';

export default async () => {
  render(<Extension />, document.body);
}

const NAMESPACE = "$app:gwp";
const KEY = "config";

const PRODUCT_FIELDS = `
  id
  title
  variants(first: 100) {
    nodes {
      id
      title
    }
  }
`;

async function ensureStorefrontMetafieldAccess() {
  // Idempotent: lets the theme app extension read this config via Liquid
  // (`shop.metafields['$app:gwp']['config']`). Safe to call on every save -
  // if the definition already exists, we just ignore the resulting error.
  try {
    const result = await adminFetch(
      `mutation EnsureGwpDefinition($definition: MetafieldDefinitionInput!) {
        metafieldDefinitionCreate(definition: $definition) {
          createdDefinition { id }
          userErrors { field message code }
        }
      }`,
      {
        definition: {
          name: "Gift With Purchase configuration",
          namespace: NAMESPACE,
          key: KEY,
          type: "json",
          ownerType: "SHOP",
          access: {admin: "MERCHANT_READ", storefront: "PUBLIC_READ"},
        },
      },
    );

    const userErrors = result.metafieldDefinitionCreate.userErrors;
    const isAlreadyExists = userErrors.some((e) => e.code === "TAKEN");
    if (userErrors.length > 0 && !isAlreadyExists) {
      console.error("GWP metafield definition userErrors", userErrors);
    }
  } catch (e) {
    console.error("GWP metafield definition creation failed", e);
  }
}

async function ensureCartTransformActive() {
  // Idempotent: registers the parks-cart-transformer function as an active
  // CartTransform for this shop/app. Needed once per app installation -
  // if the app gets deleted and recreated (new client_id), this needs to
  // run again, since the old activation doesn't carry over.
  try {
    const result = await adminFetch(
      `mutation EnsureCartTransform($functionHandle: String!) {
        cartTransformCreate(functionHandle: $functionHandle) {
          cartTransform { id }
          userErrors { field message code }
        }
      }`,
      {functionHandle: "parks-cart-transformer"},
    );

    const userErrors = result.cartTransformCreate.userErrors;
    if (userErrors.length > 0) {
      console.error("GWP cartTransformCreate userErrors (ignored if already active)", userErrors);
    } else {
      console.log("GWP cartTransformCreate result", result.cartTransformCreate.cartTransform);
    }
  } catch (e) {
    console.error("GWP cartTransformCreate failed", e);
  }
}

async function ensureCartValidationActive() {
  // Idempotent: registers the parks-cart-checkout-validation function as an
  // active, blocking Validation for this shop/app - without this, the
  // function is bundled/deployed but Shopify never actually invokes it (it
  // has to be explicitly activated, same idea as cartTransformCreate above,
  // just a different mutation for this function type). Unlike
  // metafieldDefinitionCreate's "TAKEN" error code, validationCreate has no
  // confirmed "already exists" signal to rely on, so we check for an
  // existing Validation with a matching function handle first, to avoid
  // creating duplicate Validation entries on every save (a store is capped
  // at 25 active validations).
  try {
    const existing = await adminFetch(
      `query GwpExistingValidation {
        validations(first: 50) {
          nodes {
            id
            shopifyFunction { handle }
          }
        }
      }`,
    );

    const alreadyActive = existing.validations.nodes.some(
      (node) => node.shopifyFunction?.handle === "parks-cart-checkout-validation",
    );

    if (alreadyActive) {
      console.log("GWP validationCreate skipped, already active");
      return;
    }

    const result = await adminFetch(
      `mutation EnsureCartValidation($validation: ValidationCreateInput!) {
        validationCreate(validation: $validation) {
          validation { id enabled blockOnFailure }
          userErrors { field message code }
        }
      }`,
      {
        validation: {
          functionHandle: "parks-cart-checkout-validation",
          enable: true,
          blockOnFailure: true,
          title: "Gift With Purchase enforcement",
        },
      },
    );

    const userErrors = result.validationCreate.userErrors;
    if (userErrors.length > 0) {
      console.error("GWP validationCreate userErrors", userErrors);
    } else {
      console.log("GWP validationCreate result", result.validationCreate.validation);
    }
  } catch (e) {
    console.error("GWP validationCreate failed", e);
  }
}

async function adminFetch(query, variables) {
  const res = await fetch("shopify:admin/api/graphql.json", {
    method: "POST",
    body: JSON.stringify({query, variables}),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error("GWP admin fetch failed", res.status, text);
    throw new Error(`Network error (${res.status})`);
  }

  const json = await res.json();
  if (json.errors) {
    console.error("GWP admin fetch GraphQL errors", json.errors);
    throw new Error(json.errors.map((error) => error.message).join(", "));
  }

  return json.data;
}

function Extension() {
  const {close, data, resourcePicker} = shopify;

  const [productTitle, setProductTitle] = useState('');
  const [variants, setVariants] = useState([]);
  const [shopId, setShopId] = useState(null);
  const [giftVariantId, setGiftVariantId] = useState('');
  const [minSubtotal, setMinSubtotal] = useState('');
  const [status, setStatus] = useState('active');
  const [testMode, setTestMode] = useState(false);
  const [testTag, setTestTag] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  function applyProduct(product, presetVariantId) {
    const productVariants = product.variants.nodes;
    setProductTitle(product.title);
    setVariants(productVariants);

    const presetIsOnThisProduct = productVariants.some(
      (variant) => variant.id === presetVariantId,
    );

    if (presetIsOnThisProduct) {
      setGiftVariantId(presetVariantId);
    } else if (productVariants.length > 0) {
      setGiftVariantId(productVariants[0].id);
    } else {
      setGiftVariantId('');
    }
  }

  // Runs once on mount. Shows whichever product is already configured as the
  // gift (looked up by the saved variant, regardless of which product page
  // the action was launched from) so the settings always reflect the real
  // saved state rather than resetting to "the product you happen to be on".
  useEffect(() => {
    (async function load() {
      try {
        const configResult = await adminFetch(
          `query GwpShopConfig($namespace: String!, $key: String!) {
            shop {
              id
              metafield(namespace: $namespace, key: $key) {
                value
              }
            }
          }`,
          {namespace: NAMESPACE, key: KEY},
        );

        setShopId(configResult.shop.id);

        console.log("GWP loaded shop metafield", configResult.shop.metafield);

        const existing = configResult.shop.metafield?.value
          ? JSON.parse(configResult.shop.metafield.value)
          : null;

        if (existing?.min_subtotal != null) {
          setMinSubtotal(String(existing.min_subtotal));
        }

        // Missing/older configs default to "active" so existing setups keep
        // working exactly as before this setting existed.
        setStatus(existing?.status === 'draft' ? 'draft' : 'active');
        setTestMode(Boolean(existing?.test_mode));
        setTestTag(Array.isArray(existing?.test_tag) ? (existing.test_tag[0] ?? '') : '');

        let product = null;

        if (existing?.gift_variant_id) {
          const variantResult = await adminFetch(
            `query GwpVariantProduct($id: ID!) {
              node(id: $id) {
                ... on ProductVariant {
                  product {
                    ${PRODUCT_FIELDS}
                  }
                }
              }
            }`,
            {id: existing.gift_variant_id},
          );
          product = variantResult.node?.product ?? null;
        }

        if (!product) {
          const productResult = await adminFetch(
            `query GwpCurrentProduct($id: ID!) {
              product(id: $id) {
                ${PRODUCT_FIELDS}
              }
            }`,
            {id: data.selected[0].id},
          );
          product = productResult.product;
        }

        applyProduct(product, existing?.gift_variant_id ?? null);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleChooseProduct() {
    const selection = await resourcePicker({
      type: "product",
      action: "select",
      multiple: false,
    });

    if (!selection || selection.length === 0) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const productResult = await adminFetch(
        `query GwpPickedProduct($id: ID!) {
          product(id: $id) {
            ${PRODUCT_FIELDS}
          }
        }`,
        {id: selection[0].id},
      );

      applyProduct(productResult.product, null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setError(null);

    try {
      const parsedMinSubtotal = parseFloat(minSubtotal);
      if (Number.isNaN(parsedMinSubtotal) || parsedMinSubtotal < 0) {
        throw new Error("Enter a valid minimum subtotal.");
      }
      if (!giftVariantId) {
        throw new Error("Select which variant is the free gift.");
      }
      if (testMode && !testTag.trim()) {
        throw new Error("Enter a customer tag while test mode is on.");
      }

      const value = JSON.stringify({
        status: status,
        min_subtotal: parsedMinSubtotal,
        gift_variant_id: giftVariantId,
        test_mode: testMode,
        // Always an array (even empty) so the validation function's input
        // query can bind it directly to a non-null `[String!]!` argument.
        test_tag: testMode && testTag.trim() ? [testTag.trim()] : [],
      });

      console.log("GWP saving config", {ownerId: shopId, namespace: NAMESPACE, key: KEY, value});

      await ensureStorefrontMetafieldAccess();
      await ensureCartTransformActive();
      await ensureCartValidationActive();

      const result = await adminFetch(
        `mutation SetGwpConfig($ownerId: ID!, $namespace: String!, $key: String!, $value: String!) {
          metafieldsSet(metafields: [{
            ownerId: $ownerId,
            namespace: $namespace,
            key: $key,
            type: "json",
            value: $value
          }]) {
            metafields { id namespace key value }
            userErrors { field message code }
          }
        }`,
        {ownerId: shopId, namespace: NAMESPACE, key: KEY, value},
      );

      console.log("GWP save result", result.metafieldsSet);

      const userErrors = result.metafieldsSet.userErrors;
      if (userErrors.length > 0) {
        console.error("GWP save userErrors", userErrors);
        throw new Error(userErrors.map((e) => `${e.field ?? ''} ${e.message}`.trim()).join(", "));
      }

      close();
    } catch (e) {
      console.error("GWP save failed", e);
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <s-admin-action>
      <s-stack direction="block" gap="base">
        <s-heading>Gift With Purchase settings</s-heading>
        {loading && <s-spinner accessibilityLabel="Loading" />}
        {error && <s-banner tone="critical">{error}</s-banner>}
        {!loading && (
          <>
            <s-select
              label="Status"
              details="Draft: the gift never appears anywhere, for anyone, regardless of other settings. Active: the gift works normally (subject to test mode below, if on)."
              value={status}
              onChange={(e) => setStatus(e.currentTarget.value)}
            >
              <s-option value="active">Active</s-option>
              <s-option value="draft">Draft</s-option>
            </s-select>
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-text>Gift product: {productTitle}</s-text>
              <s-button onClick={handleChooseProduct}>Choose a different product</s-button>
            </s-stack>
            {variants.length > 1 ? (
              <s-select
                label="Gift variant"
                value={giftVariantId}
                onChange={(e) => setGiftVariantId(e.currentTarget.value)}
              >
                {variants.map((variant) => (
                  <s-option key={variant.id} value={variant.id}>
                    {variant.title}
                  </s-option>
                ))}
              </s-select>
            ) : (
              <s-text>This product's variant will be used as the gift.</s-text>
            )}
            <s-number-field
              label="Minimum order subtotal to qualify ($)"
              value={minSubtotal}
              min={0}
              step={0.01}
              onChange={(e) => setMinSubtotal(e.currentTarget.value)}
            />
            <s-switch
              label="Test mode"
              details="While on, only logged-in customers with the tag below get the gift. Everyone else sees no change."
              checked={testMode}
              onChange={(e) => setTestMode(e.currentTarget.checked)}
            />
            {testMode && (
              <s-text-field
                label="Test customer tag"
                value={testTag}
                onChange={(e) => setTestTag(e.currentTarget.value)}
              />
            )}
          </>
        )}
      </s-stack>
      <s-button slot="primary-action" disabled={loading || saving} onClick={handleSave}>
        {saving ? "Saving..." : "Save"}
      </s-button>
      <s-button slot="secondary-actions" onClick={close}>
        Close
      </s-button>
    </s-admin-action>
  );
}
