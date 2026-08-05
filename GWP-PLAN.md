# GWP Cart Transformer — plan and context

Shopify extension-only app: "Gift With Purchase" (free gift when crossing a
minimum subtotal). Based on the architecture of `free-gift-gwp-validation`
(sibling project, same parent repo), simplifying duplicate gift-line
consolidation with a Cart Transform Function (`linesMerge`) instead of
storefront JS logic.

Target store: **confirmed Shopify Plus** (see "Plus pivot" below).
`lineUpdate` / price override in `linesMerge` ARE used, so we don't depend
on the merchant manually setting the gift variant to $0 in the catalog.

## The 4 extensions

| Extension | Handle | Type | Role |
|---|---|---|---|
| Admin action | `parks-admin-action-ui` | `ui_extension` (admin.product-details.action.render) | UI to pick the gift product/variant, min_subtotal, status, test mode/tag. Saves everything to `shop.metafields['$app:gwp']['config']`. Registers the metafield definition (storefront PUBLIC_READ) and activates the Cart Transform (`cartTransformCreate`), both idempotently. |
| Theme extension | `parks-theme-extension` | `theme` (app embed block) | Reads the config via Liquid, injects it into `<script id="gwp-config">`, and the JS adds/removes the gift line as the subtotal qualifies or not. |
| Cart Transform Function | `parks-cart-transformer` | `function` (`cart.transform.run`) | 1 line of `gift_variant_id` → `lineUpdate` clamps it to $0. 2+ lines → `linesMerge` folds them into one AND clamps to $0 in the same operation. **The only new piece relative to the reference project.** |
| Cart & Checkout Validation Function | `parks-cart-checkout-validation` | `function` (`cart.validations.generate.run`) | Server-side enforcement: blocks checkout if the gift is in the cart and the subtotal doesn't reach the minimum, or if the total gift quantity exceeds 1. Doesn't trust the JS or the transform. |

Metafield shared by all of them: shop metafield `$app:gwp.config` (json):
`status` (active/draft), `min_subtotal`, `gift_variant_id`, `test_mode`,
`test_tag[]`.

Access scopes (`shopify.app.toml`): `read_products, write_products,
read_customers, write_cart_transforms, write_validations` (the last one
doesn't actually let the extension activate the validation function — see
point 6 — but it's declared anyway because `write_validations` is still
required for the mutation to work from any context with offline access).

## Decisions made explicitly with the user (not assumed)

### 1. `linesMerge` self-referencing — EXPERIMENTAL, unconfirmed in Shopify's docs

I researched the official docs (`shopify.dev/docs/api/functions/latest/cart-transform`)
and several `Shopify/function-examples` / `Shopify/shopify-function-javascript`
issues. Every real-world `linesMerge` example uses a `parentVariantId`
**different** from the merged variants (bundle pattern: N components → 1
dedicated bundle variant). No source confirms or rules out `parentVariantId`
being the **same** variant as the merged lines (our case: 2+ lines of the
same gift variant → 1 line of that same variant), nor how the resulting
quantity is computed in that degenerate case (we assume: sum of the input
lines' quantities, since that's the only reasonable reading of the
`CartLineInput.quantity` field, but it isn't documented).

**User's decision:** proceed with self-referencing (`parentVariantId =
gift_variant_id`) anyway, accepting it's an undocumented use. Explicitly
flagged in the code as EXPERIMENTAL. **Before trusting this in production,
it must be verified live** with `shopify app dev` against a real cart: add
the gift variant twice (two separate calls to `/cart/add.js` or an external
app) and confirm it actually collapses into a single line, and what
quantity it shows. The local tests (vitest + shopify-function-test-helpers)
only validate the output's shape against the schema — they don't run the
real checkout engine, so they don't prove Shopify accepts/renders this
correctly.

If live verification shows this doesn't work (error, or no merge), this
function should be reverted to `NO_CHANGES` and duplicate consolidation
moved back to the storefront JS (see below, code removed but easy to
restore from `free-gift-gwp-validation`).

### 2. The atomic 422 retry patch STAYS (not removed)

The original plan assumed `linesMerge` would make both (a) consolidating
duplicates in JS and (b) the atomic retry patch on 422 unnecessary. I
verified these are two distinct problems:

- **(a) Consolidating duplicates** — yes, solved by `linesMerge`. Removed
  from the JS.
- **(b) The 422 deadlock** — the validation function can reject a quantity
  change on the **customer's own** line (not the gift's) if that change
  would drop the subtotal below the minimum while the gift is still
  present, **even with a single gift line, no duplicates at all**.
  `linesMerge` doesn't touch this scenario at all (no duplicate lines
  involved). Removing the patch would reintroduce this deadlock (customer
  stuck, unable to lower their quantity).

**User's decision:** keep the atomic retry patch intact. Only the
"consolidate duplicates" logic (keep 1, delete the rest) is removed.

### 3. Plus pivot: enabling the price clamp with `lineUpdate`/`linesMerge`

The project's entire initial premise (and the `GWP_LINE_UPDATE_TODO` comment
left as a flag) assumed the target store was **not** Plus. The user later
confirmed (with a screenshot of `Settings → Plan` showing "Plus") that it
**is**. This invalidates the original reason for avoiding `lineUpdate`, and
opens the door to the gift's $0 no longer depending on the merchant manually
setting the variant to $0 in the catalog.

Before enabling it I researched an important detail: an issue reported in
`Shopify/function-examples#470` documents that applying an `update`
operation AND a `merge` operation on the **same original cart line** within
the same function result makes Shopify **silently ignore the update's price
change** (contradicting the official docs, which say both should apply). To
avoid stepping on that bug, the final design NEVER combines `lineUpdate` +
`linesMerge` on the same line. Instead:

- **0 or 1 gift line** → `lineUpdate` with
  `price.adjustment.fixedPricePerUnit.amount = "0.00"` on that line.
- **2+ gift lines** → `linesMerge` with its own
  `price.percentageDecrease.value = "100.0"` (100% discount = $0) in the
  SAME merge operation, with no additional `lineUpdate`. This achieves
  "merge + zero out" without ever combining two different operations on the
  same original line, which is exactly the broken scenario from issue #470.

**Things still unconfirmed (pending live verification, in addition to point
1's `linesMerge` self-referencing):**
- The exact format/scale of `percentageDecrease.value` (assumed 0-100, like
  Shopify's Discount Functions; no official `linesMerge`/`merge` example
  with `price` confirms it with a concrete value).
- Whether `linesMerge` with `price` works just as well in the
  self-referencing case (parentVariantId = the merged variant) as in the
  normal, documented bundle case.

This means the merchant **no longer needs** to set the gift variant to $0
in the catalog — the function now forces the $0. It's still good practice
to have a variant dedicated exclusively to the gift (hidden, not sellable
any other way) so that a `lineUpdate`/`linesMerge` with a 100% discount
doesn't accidentally give away a variant that's also sold normally.

### 4. Marker pivot: transform and validation now filter by `_gwp_gift`

Direct consequence of point 3: since the catalog is no longer the source of
the $0, the same variant can have a real price (e.g. $25) and at the same
time have a line clamped to $0 by the function. This means it's no longer
safe to treat "any line matching the variant" as "the gift" — a customer
who genuinely adds a second unit of the same variant (not through the theme
JS, so without the `_gwp_gift: true` property) expects to pay full price
for it, and it should NOT:
- also get clamped to $0 (accidentally giving it away), nor
- count toward the "minimum subtotal" / "max 1 gift" rules and block their
  checkout with "Only one free gift is allowed" over something they're
  genuinely paying for.

**User's decision:** filter by the `_gwp_gift: true` marker in BOTH
functions (not just the transform):
- `parks-cart-transformer`: only marked lines get clamped to $0 / merged.
  Any line of the same variant without the marker stays completely
  untouched, at its real catalog price.
- `parks-cart-checkout-validation`: only marked lines count toward
  `giftQuantity` (minimum subtotal and "max 1 gift"). An unmarked line
  never blocks checkout.

This reverses an earlier design decision (matching by variant id, ignoring
the marker, inherited from when the catalog ALWAYS had the variant at $0
and there was no need to distinguish). Accepted risk: someone with
technical access (direct API, another app) could in theory try to spoof the
`_gwp_gift: true` property to give themselves the variant for free — but
that already requires stepping outside the normal storefront/checkout flow,
outside this app's scope.

The transform already adds `_gwp_gift`/`Gift` as attributes when merging
duplicate lines (`linesMerge.attributes`), so the resulting merged line
stays marked and the validation function keeps recognizing it correctly
after the merge.

### 5. REAL BUG found live: the validation function was never running

Testing live (`testing-david-plus.myshopify.com`), the user reported that
checkout let 4 gift units through without blocking. Diagnosed via
`.shopify/logs`: **53 recorded invocations of `parks-cart-transformer`, 0
of `parks-cart-checkout-validation`, ever** - the function wasn't even
running (not a logic bug in `cartValidationsGenerateRun`).

Root cause: unlike the reference project `free-gift-gwp-validation` (which
also didn't have this and was probably never tested live), this function
was missing an explicit activation via the `validationCreate` mutation -
exactly the same kind of step that `cartTransformCreate` does for the Cart
Transform, but for `cart.validations.generate.run`-type functions. Without
that call, the extension compiles and registers in the bundle (visible in
`.shopify/dev-bundle/manifest.json`), but Shopify never invokes it.

First attempt (fixed later, see point 6 below - **spoiler: this approach
doesn't work from a UI extension and was eventually reverted**):
- `write_validations` scope added to `shopify.app.toml` (required by
  `validationCreate`).
- `ensureCartValidationActive()` in `ActionExtension.jsx`: first queries
  `validations(first: 50) { nodes { shopifyFunction { handle } } }` to check
  whether a Validation with `handle: "parks-cart-checkout-validation"`
  already exists (there's no confirmed "already exists" error code for
  `validationCreate`, so this avoids duplicating validations - the store
  has a cap of 25). If none exists, calls `validationCreate` with
  `enable: true, blockOnFailure: true`. Runs on every save, alongside
  `ensureStorefrontMetafieldAccess` and `ensureCartTransformActive`.

After reinstalling the app with the new scope and saving again, the
validation STILL didn't activate - the real reason (it wasn't the scope) is
explained in point 6. `ensureCartValidationActive()` was removed from the
final code.

### 6. `validationCreate` CANNOT be called from a UI extension (platform limitation, not a bug)

After reinstalling the app with the `write_validations` scope and saving the
Admin Action several times, `.shopify/logs` kept showing **0 invocations**
of `parks-cart-checkout-validation` (against 53+ for the transform). And in
Shopify Admin → Settings → Apps → parks-gwp-cart-transformer it kept
showing **"Functions: 1 active"** (just the transform), even after
re-saving.

Diagnosis: I tested the SAME `validationCreate` mutation by hand in the
local GraphiQL exposed by `shopify app dev`
(`http://localhost:3457/graphiql`) against the same store/app, and there it
**did work** (`enabled: true, blockOnFailure: true`, no userErrors). This
rules out a syntax problem, a scope problem, or a problem with the mutation
itself - the same code, from a different context, works.

The real difference: Admin UI Extensions make "Direct API access" calls to
the Admin GraphQL API (`fetch("shopify:admin/api/graphql.json")`) in
**online** mode, with the logged-in staff member's permissions, not with
the app's **offline** install token. `validationCreate` requires offline
access (documented by Shopify: "*If your extension needs to use offline
access mode, you should make requests using your app's backend*"). The
CLI's GraphiQL does use a token with offline access, which is why it works
there. `cartTransformCreate`, on the other hand, IS reachable in online
mode (which is why `ensureCartTransformActive()` works fine from the
extension) - not every "activation" mutation has the same access
requirement.

**Architectural consequence:** a 100% extension-only app (no backend, which
is exactly this project's goal) **cannot programmatically activate** the
Cart & Checkout Validation function from any of its own extensions. There's
no way around it without adding a backend.

**User's decision:** remove `ensureCartValidationActive()` from the admin
action (code that can never succeed, don't leave it in as a false
best-effort) and document here the one-time manual step that has to be run
once per shop/install:

```graphql
mutation {
  validationCreate(validation: {
    functionHandle: "parks-cart-checkout-validation"
    enable: true
    blockOnFailure: true
    title: "Gift With Purchase enforcement"
  }) {
    validation { id enabled blockOnFailure }
    userErrors { field message code }
  }
}
```

How to run it: with `shopify app dev` running, open
`http://localhost:3457/graphiql` (local URL printed by the CLI itself) and
run the mutation above against the connected store. Needed once per store -
if the app gets uninstalled and reinstalled on that store, it has to be run
again (same rule as `cartTransformCreate`, except that one is automated and
this one isn't). Before running it, it's worth checking there isn't already
a validation for this handle:

```graphql
query {
  validations(first: 50) {
    nodes { id enabled shopifyFunction { handle } }
  }
}
```

### 7. REAL BUG found live: the theme's App Embed was OFF

After activating the validation function (point 6), the theme JS
(`gwp-add-to-cart.js`) still wasn't running on the real storefront: no
`[GWP]` logs in the console, no network request for the file. The block's
liquid (`shop.metafields['$app:gwp']['config']`) was fine.

Root cause: the "Gift With Purchase" toggle in Theme Editor → App embeds
was off for the theme actually serving the test storefront ("parks-project",
Draft, not the auto-generated "App Ext. Host" used by the isolated preview
at `127.0.0.1:9293`). App Embeds don't turn themselves on with
`shopify app dev`; they have to be turned on by hand, per theme, and the
toggle seems to reset to OFF when the app is uninstalled/reinstalled.

**Fix:** manually turn the toggle on in the correct theme's Theme Editor and
save. Confirmed afterward: `window.fetch` ends up patched (no longer
native) and `#gwp-config` shows up in the HTML with the correct values.

### 8. Test cart stuck with 2 gifts, no mutation fixes it — diagnosis

The user reported (once validation was already active and the App Embed
already on) a cart with the gift line at quantity 2, correctly blocked at
checkout ("Only one free gift is allowed per order.") — but **no** attempt
to fix it from the storefront worked: not lowering that line to 1, not to
0, not changing an unrelated line's quantity, not `/cart/clear.js`, not the
`/cart/clear` link. All of them returned the same 422, even mutations that
should have left the cart in a valid state.

**Verification on a 100% fresh cart** (cart cookie manually cleared, never
visited `/checkout`): tried to reproduce the same invalid state through
every possible route — a single `/cart/add.js` call with quantity 2, two
concurrent `/cart/add.js` calls (`Promise.all`), and `/cart/change.js`
bumping an existing line from 1 to 2 — and in all three cases Shopify
blocked the mutation **before** it applied (the line never actually reached
quantity 2; the cart stayed intact and valid the whole time). It wasn't
possible to reproduce the stuck state from scratch.

**Conclusion:** the user's stuck cart almost certainly entered that invalid
state **before** the validation function was actually active (recall point
6: `validationCreate` never ran until it was manually activated via
GraphiQL, mid-way through this testing session). Once activated, the
validation started evaluating a cart that already carried the violation
from before, and since Shopify's checkout appears to block **every**
mutation on a cart with an active failing validation (not just the one that
caused it), there's no mutation that can retroactively get it out of that
state from the storefront. No recovery path was found other than
abandoning that cart (new cookies / new window) — for a real customer's
cart this shouldn't happen again, since the validation is now active from
the very first mutation onward.

**Real bug found along the way (fixed):** `gwp-add-to-cart.js` had a
function `isAnyGiftVariantLine` that identified "the gift line" by
`variant_id` alone, without checking the `_gwp_gift` marker — it had stayed
that way since before the "marker pivot" (point 4) and was never updated to
reflect it. Consequence: if a customer had both the marked gift line AND a
second unit of the same variant genuinely purchased at normal price (the
exact scenario point 4 exists to support), and the offer stopped applying
(e.g. the subtotal dropped, or the market changed), the automatic cleanup
(`removeLines`) would wipe out **both** lines — including the one the
customer paid for. Renamed to `isMarkedGiftLine`, now also requires
`item.properties['_gwp_gift'] === 'true'`, consistent with the transform
and the validation function.

### 9. What exactly happens when GWP is "turned off"

There are TWO independent switches, and turning one off doesn't turn the
other off:

**A) `status: "draft"` in the Admin Action** (the switch meant for "turn the
offer off"). Effect on each of the 4 pieces:
- **Theme JS**: `offerApplies()` returns `false` → never adds the gift, and
  if a marked line already existed it actively removes it on the next sync
  (`removeLines`). This was already correct before today.
- **Cart Transform**: **bug found and fixed today** — the function never
  checked `status`, so if for any reason a marked line stayed alive (JS
  hadn't run its cleanup yet, or the App Embed is off), it kept clamping it
  to $0 **forever**, with the validation function protecting nothing (see
  next point). Now, with `status: "draft"`, the transform returns
  `NO_CHANGES` and that line goes back to its normal catalog price.
- **Validation function**: already returned `{ operations: [] }` in draft
  (no change today) — blocks nothing.
- **Net result with `status: "draft"`**: the gift variant behaves like a
  100% normal product in every sense — no auto-add, no $0, no checkout
  rules — regardless of what happens with the App Embed.

**B) The App Embed toggle in the Theme Editor** (only turns off the
storefront JS, nothing server-side). If this is turned off but `status`
stays `"active"`:
- No new gifts get added to anyone (the script that would do it doesn't
  run).
- A marked line a customer already had in their cart BEFORE the embed was
  turned off doesn't clean itself up (nobody runs `removeLines`) — it stays
  clamped to $0 by the transform and still counts toward the validation
  function's rules (because `status` is still active). This is expected:
  turning off just the embed means "stop offering the gift to new people,"
  not "revoke gifts already granted to existing carts."
- For a full, clean shutdown, `status: "draft"` has to be set (not just the
  embed turned off).

**Should the Validation function resource itself (the `validationCreate`
resource in Shopify) get disabled/deleted when GWP is turned off?** Not
feasible and not necessary. Not feasible: `validationUpdate`/deleting it
requires offline access, the same architectural limitation from point 6 —
this extension could never do it. Not necessary: with `status: "draft"` the
function stays technically "active" in Shopify but is a total no-op
(always returns `{ operations: [] }`, without logging any error) because
there are never any marked lines to evaluate — the effect for the merchant
and the customer is identical to it being disabled.

### 10. The offer requires a logged-in customer (all 3 enforcement layers)

**User's decision:** an anonymous (not logged in) visitor must never receive
the free gift, regardless of subtotal/country/status. Live-tested and found
this was NOT previously enforced anywhere — with `test_mode` off, any
visitor (logged in or not) that met the subtotal/US/USD conditions got the
gift. Fixed in all 3 layers, mirroring the existing `status: "draft"`
pattern:

- **Theme JS** (`gwp-add-to-cart.js`): `offerApplies()` now also requires
  `config.logged_in`, sourced from a new `"logged_in"` key in the
  `#gwp-config` script tag (`gwp-add-to-cart.liquid`), set from Liquid's
  `{% if customer %}`. If the customer logs out mid-session and a marked
  line already exists, the next sync removes it, same as any other
  "no longer qualifies" condition.
- **Cart Transform** (`cart_transform_run.ts`): queries
  `cart.buyerIdentity.isAuthenticated` and returns `NO_CHANGES` if false,
  right after the `status: "draft"` check - a marked line on an anonymous
  cart is not clamped to $0.
- **Validation function** (`cart_validations_generate_run.ts`): also queries
  `cart.buyerIdentity.isAuthenticated`; if a marked gift line is present
  (`giftQuantity > 0`) and the buyer isn't authenticated, checkout is
  blocked with "Please log in to your account to receive the free gift." -
  this is the layer that can't be bypassed by skipping the storefront.

Both function `.graphql` input queries were updated to request
`buyerIdentity { isAuthenticated }` and their `generated/api.ts` types were
regenerated (`shopify app function typegen`) accordingly. All pre-existing
test fixtures that expect the gift to actually apply were updated to
include `"buyerIdentity": {"isAuthenticated": true}`; two new fixtures
(`not-authenticated-leaves-marked-line-untouched.json` for the transform,
`not-authenticated-blocks-checkout.json` for validation) cover the blocked
case.

**Live-verified after deploy (`parks-gwp-cart-transformer-4`)** on
`testing-david-plus.myshopify.com`: logged-in + qualifying subtotal → gift
added at $0, a second add attempt correctly blocked ("Only one free gift is
allowed per order"); logged out (via `/account/logout`) + qualifying
subtotal → gift add correctly blocked with the new "Please log in..."
error, no line ever added.

**The deadlock this created, and how it was solved.** Emitting a validation
error for "marked gift line present + not authenticated" broke the theme
JS's automatic cleanup: an error returned by a cart-validation function
blocks EVERY cart mutation while the condition holds, *including* the
`/cart/change.js` (`quantity: 0`) that the script fires to remove that very
line. Confirmed live from the function-run logs: each removal attempt was
rejected 422 with our own "Please log in..." message, the failed request
re-triggered `liquid-ajax-cart:request-end` -> another sync -> another
rejected removal, at dozens of requests per second (which tripped Shopify's
rate limiting and a Cloudflare CAPTCHA on the test store). The gift line
could then only be removed by hand - the opposite of the point of the
feature.

The fix is to make the validation function ignore marked lines that aren't
actually free. The Cart Transform runs BEFORE validation (transform ->
discounts -> validation), and it only clamps a marked line to $0 when the
offer genuinely applies (active + authenticated). So the price validation
sees is already the verdict: a marked line still at its catalog price is
one the transform deliberately refused to make free - a leftover, not a
free gift - and validation now treats it as an ordinary purchase and
returns no errors. The removal is no longer blocked and the cleanup lands
on the first try. Requires `cost { amountPerQuantity { amount } }` in the
validation's input query.

This keeps the checkout guarantee intact: if a genuinely free ($0) marked
line ever reaches an unauthenticated cart (i.e. the transform was bypassed
or failed), `giftQuantity > 0` still holds and checkout is still blocked.
The two cases are covered by separate fixtures -
`not-authenticated-blocks-checkout.json` ($0 line -> blocked) and
`leftover-full-price-gift-line-does-not-block.json` (catalog-price line ->
no errors, so cleanup can proceed).

**Caveat:** this relies on the gift variant's catalog price NOT being $0
(consistent with the "Plus pivot" decision - the transform exists precisely
so the merchant doesn't have to zero it out). If a merchant does set the
gift variant to $0 in the catalog, a leftover marked line looks "free" to
validation and the deadlock returns.

**Two supporting guards in `gwp-add-to-cart.js`,** both worth keeping
independently of the above:
- `CLEANUP_RETRY_COOLDOWN_MS` (5s) in `syncGiftLine()` - caps automatic
  cleanup retries so that *any* future condition that blocks a removal
  degrades into one attempt per interval (the 10s poll still guarantees
  eventual cleanup) instead of a request storm.
- A no-op guard in `retryBlockedChangeAsCombinedUpdate()`: if the blocked
  request only touched a gift line, the "compensating" combined update
  would be byte-for-byte the request that was just rejected, so retrying it
  only loops. `isGiftThresholdError` therefore deliberately matches ONLY
  the subtotal-threshold message - an earlier attempt to also match the
  login message routed our own removal failures into this retry path and
  amplified the loop.

**Live-verified after deploy (`parks-gwp-cart-transformer-8`),** against
the real published theme with all dev previews cleared: anonymous cart
holding a leftover marked line at its catalog price ($4.00, i.e. the
transform correctly refused to clamp it) -> on page load the line was
removed automatically, no manual action, and zero cart requests in the
following 8 seconds (previously dozens per second).

**Debugging gotcha that cost hours - check this FIRST:** if the storefront
renders no `#gwp-config` and no `gwp-add-to-cart.js` at all, the app is
probably fine and the browser is simply being served a different theme.
Confirm with `Shopify.theme.id` / `Shopify.theme.name` in the console and
compare against the active theme. A `shopify app dev` session creates a
development theme and pins the browser to it with a preview cookie that
survives killing the process; that theme does not have the app embed
enabled, so the block renders nothing and it looks exactly like the config
metafield was deleted. It was not - verify with GraphiQL (the CLI exposes
it on port 3457 during `shopify app dev`):

    query { shop { metafield(namespace: "app--<app_id>--gwp", key: "config") { value } } }
    query { metafieldDefinitions(first: 25, ownerType: SHOP) { nodes { namespace key access { storefront } } } }

Recover by loading `?preview_theme_id=<active_theme_id>` (or "Exit preview"
in the storefront bar), then "Clean dev preview" in the Dev Console so the
released app version is served instead of the dev bundle.

**Test-session caveat:** the live debugging session that produced the
findings in this section got heavily contaminated - multiple stray `shopify app dev`
processes overriding the theme's extension preview at different times, a
leftover draft "Development" theme with its own stale dev-preview cookie
that silently redirected testing away from the real published theme for a
stretch, and eventually Shopify's own bot-protection (429s, then a
Cloudflare CAPTCHA) from the sheer request volume. Several early
conclusions in this session were revised after discovering the actual
theme/version being tested was wrong. Treat the "known issue" above as
worth re-verifying with a single clean tab against the real published
theme (no dev preview active) before treating it as fully characterized.

**QA gotcha, not a bug:** `#gwp-config` (including `logged_in` and
`customer_tags`) is rendered server-side by Liquid at page load, same as
`country`/`currency` - it does NOT update reactively if the customer logs
in/out without a full page reload. A stale/un-refreshed page can show
`logged_in: false` right after logging in. Always reload the page being
tested after any login/logout before checking `#gwp-config` or reporting a
mismatch.

## What's different from `free-gift-gwp-validation`

- **Admin action**: code reused almost verbatim + adds
  `ensureCartTransformActive()` (identical in spirit to commit `79ebec7` from
  the reference project, adapted to the `parks-cart-transformer` handle).
- **Theme extension JS**: `installGiftThresholdRetry` is NOT removed - it
  stays. Only the `giftLines.length > 1` branch (consolidate duplicates) is
  removed from `syncGiftLine`. The adjustment to quantity 1 when there's
  exactly one gift line with quantity ≠ 1 is kept (not the same as
  "consolidate duplicates": no other line is involved, so it doesn't
  reintroduce the atomic retry problem).
- **Cart Transform Function**: new, with the price clamp active (see "Plus
  pivot" above) — the target store confirmed as Plus, so `lineUpdate`/
  `linesMerge` with `price` are used to force the $0 server-side, avoiding
  reliance on the catalog having the variant at $0.
- **Cart & Checkout Validation Function**: sums the quantity of ONLY the
  lines marked with `_gwp_gift: true` (see point 4, "Marker pivot") — not
  every line matching `gift_variant_id`. Still the correct defense if the
  experimental merge were to fail (2 marked lines that never got merged
  still sum their total quantity).

## Implementation status

See the session's TaskList. Extensions already scaffolded by the CLI with
the correct handles (`parks-admin-action-ui`, `parks-theme-extension`,
`parks-cart-transformer`, `parks-cart-checkout-validation`) — placeholder
content still needed replacing with the real logic described above.

## Operator's guide: modes, shutdown, and failure modes

Which layer enforces what (verified by reading each source, not assumed):

| Rule | Theme JS | Cart Transform | Validation |
|---|---|---|---|
| `status: "draft"` | yes | yes | yes |
| Customer logged in | yes | yes | yes |
| US / USD only | yes | **NO** | yes |
| Minimum subtotal | yes | **NO** | yes |
| `test_mode` + tag | yes | **NO** | **NO** |
| Only one gift | no | merges duplicates | yes |

Two of those gaps matter operationally and are described below.

### Use case 1: `status` active vs draft

`status` is the real master switch: it is the only setting all three layers
respect. See point 9 for the per-layer detail.

- **active** - offer runs normally, subject to the other conditions.
- **draft** - every layer turns itself off. The theme JS removes any marked
  line it finds, the transform stops clamping to $0, and the validation
  stops blocking. The gift variant behaves as a 100% ordinary product.

**To shut GWP down completely, set `status: "draft"`.** Nothing else is
required, and nothing else is sufficient.

### Use case 2: test mode

`test_mode` + `test_tag` restrict the offer to logged-in customers carrying
the configured tag, so the offer can be rehearsed on a live store without
exposing it to real shoppers.

**Important: test mode is enforced in the storefront JS only** (0 references
in either function - grep to confirm). It controls *who is offered the
gift*; it is not a security boundary. If a marked gift line reaches the cart
of a customer without the tag, the transform still prices it at $0 and the
validation still treats it as a real gift. In practice the JS is the only
thing that adds the line, so this is a small hole - but do not treat test
mode as "the offer cannot possibly apply to anyone else".

Test mode also stacks on top of the login requirement (point 10): an
anonymous visitor never qualifies, tag or not.

### Use case 3: turning things off - what NOT to use

**The App embed toggle is not a kill switch.** Turning it off stops the JS
from loading, which stops new gifts being added - but the transform and the
validation keep running server-side. A cart that already holds a marked line
keeps getting it at $0 *and* keeps hitting validation errors that now have
nothing to recover them (see below). Use `status: "draft"` instead, and leave
the embed alone.

### Possible errors and how to diagnose them

**1. The offer does nothing at all; no `#gwp-config` in the page source.**
Almost always the browser is on a different theme, not a broken config.
Check `Shopify.theme.id` / `.name` in the console against the active theme.
See the debugging gotcha in point 10 for the full recovery.

**2. The storefront is running old code after a deploy.** A `shopify app dev`
session pins a dev bundle that overrides the released version, and it
survives killing the process. Confirm by looking for `/dev-` in the
`gwp-add-to-cart.js` URL; recover with "Clean dev preview" in the Dev
Console. Almost every confusing result during development traces back to
this.

**3. Customer cannot lower a quantity ("must be at least $X" error, and
nothing happens).** The validation rejects the cart mutation, and the
recovery - the compensating combined update - lives entirely in the
storefront JS. If that JS is not loaded (app embed off, ad blocker, script
error, theme pushed without the embed), the customer is simply stuck. This
is the most user-visible failure and the one worth designing away; see
"Known structural weakness" below.

**4. Pushing this repo's theme silently disables GWP.** App embed enablement
lives in `config/settings_data.json` under `current.blocks`. If the local
copy of that file predates the embed being enabled, pushing the theme
removes the block from the live theme and the whole feature stops - with no
error anywhere. Check that `settings_data.json` contains a
`shopify://apps/parks-gwp-cart-transformer/blocks/gwp-add-to-cart/...` entry
with `"disabled": false` before deploying a theme.

**5. Gift stays free outside the US.** The transform never checks country -
only the JS and the validation do. A marked line on a non-US cart is still
clamped to $0 by the transform, and the validation deliberately allows
non-US checkouts through, so nothing stops it. Reaching that state requires
the JS to have failed to clean up after a market switch, but it is a real
hole. `localization` IS available in the transform's input (it simply isn't
queried), so this is fixable, not a platform limit.

### Known structural weakness (not yet addressed)

Errors 3 and 5 share a root cause: **the server can create states that only
the client can get out of.** The validation blocks a cart mutation, and the
only thing that resolves it is storefront JS.

Two fixes are available and neither is speculative:

- The validation's input exposes `buyerJourney`, which distinguishes cart
  interaction from checkout. Restricting the blocking rules to the checkout
  step would stop them from ever rejecting a legitimate cart edit, removing
  the entire deadlock class.
- The transform can read `cost.amountPerQuantity` per line and `localization`,
  so it could decide "qualifies" itself and simply not make the line free.
  Combined with the validation's existing "only enforce on lines that are
  actually free" gate (point 10), a non-qualifying cart would produce no
  error at all - so nothing would need recovering, with or without JS.

Until one of these lands, treat the storefront JS as load-bearing: if it
does not run, carts holding a gift line can get stuck.
