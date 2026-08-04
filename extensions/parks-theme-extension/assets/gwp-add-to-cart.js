(function () {
  var configEl = document.getElementById('gwp-config');
  if (!configEl) {
    console.log('[GWP] no #gwp-config script tag found on page');
    return;
  }

  var config;
  try {
    config = JSON.parse(configEl.textContent);
  } catch (e) {
    console.error('[GWP] failed to parse #gwp-config JSON', e, configEl.textContent);
    return;
  }

  console.log('[GWP] loaded config', config);

  // Only truly bail (never track the cart at all) if we can't even identify
  // which variant is "the gift" - without that we have nothing to clean up
  // either. Every other condition below (status, country/currency, test
  // mode) must NOT just stop and do nothing: if the customer already has
  // the gift line and a condition stops applying (e.g. they switch their
  // market from US to another country mid-session), we still need to
  // actively remove it - not just leave it sitting in the cart forever.
  if (!config.gift_variant_id) {
    console.log('[GWP] no gift_variant_id in config, stopping');
    return;
  }

  var giftVariantId = Number(String(config.gift_variant_id).split('/').pop());
  var minSubtotal = Number(config.min_subtotal);
  var GIFT_MARKER_KEY = '_gwp_gift';
  var GIFT_MESSAGE_KEY = 'Gift';
  var GIFT_MESSAGE_VALUE = 'Free Gift With Purchase';
  var syncing = false;
  var syncQueued = false;
  // If a cleanup removal gets rejected by the validation function (or fails
  // for any other reason), Liquid Ajax Cart still dispatches
  // 'liquid-ajax-cart:request-end' for the failed request, which
  // immediately re-triggers syncGiftLine -> another removal attempt ->
  // another failed request-end event, forever, as fast as the network
  // allows. Confirmed live: this produced dozens of requests/second against
  // the store. This cooldown caps retries to once per interval; the poll
  // (10s) still guarantees eventual cleanup once whatever is blocking it
  // resolves.
  var CLEANUP_RETRY_COOLDOWN_MS = 5000;
  var lastCleanupAttemptAt = 0;

  function hasLiquidAjaxCart() {
    return typeof window.liquidAjaxCart !== 'undefined' && window.liquidAjaxCart !== null;
  }

  // Only lines WE marked are "the gift" - a customer can add the same
  // variant a second time as a genuine, normal-priced purchase (the Cart
  // Transform and Validation functions already treat unmarked lines that
  // way, see GWP-PLAN.md "marker pivot"). If we matched on variant id alone,
  // a market/subtotal change that makes the offer stop applying would wipe
  // out that paid line too, not just the free one.
  //
  // Duplicate-line consolidation ("keep 1, delete the rest") used to live
  // here in JS. That's now handled server-side by the parks-cart-transformer
  // Cart Transform Function (`linesMerge`), which folds any duplicate gift
  // lines into one before the cart is ever displayed - see GWP-PLAN.md for
  // why that's currently marked experimental/unverified in production.
  function isMarkedGiftLine(item) {
    return item.variant_id === giftVariantId && item.properties && item.properties[GIFT_MARKER_KEY] === 'true';
  }

  // Re-checked on every sync (not just once at page load) so a customer
  // switching country/market, or a merchant flipping status/test mode,
  // takes effect on the very next sync - not just on their next page load.
  function offerApplies() {
    if (config.status !== 'active') {
      return false;
    }
    if (!config.logged_in) {
      return false;
    }
    if (config.country !== 'US' || config.currency !== 'USD') {
      return false;
    }
    if (config.test_mode) {
      var testTags = Array.isArray(config.test_tag) ? config.test_tag : [];
      var customerTags = Array.isArray(config.customer_tags) ? config.customer_tags : [];
      var hasTestTag = testTags.some(function (tag) {
        return customerTags.indexOf(tag) !== -1;
      });
      if (!hasTestTag) {
        return false;
      }
    }
    return true;
  }

  function getCart() {
    if (hasLiquidAjaxCart() && window.liquidAjaxCart.cart) {
      return Promise.resolve(window.liquidAjaxCart.cart);
    }
    return fetch('/cart.js', {headers: {Accept: 'application/json'}}).then(function (res) {
      if (!res.ok) {
        throw new Error('Failed to load cart (' + res.status + ')');
      }
      return res.json();
    });
  }

  // Liquid Ajax Cart (https://liquid-ajax-cart.js.org) queues its requests -
  // using its own add/change methods means our mutation runs in the SAME
  // queue as the theme's own actions (never concurrently), which is what
  // avoids the cart getting stuck when we and the customer act at once.
  function addGift() {
    var properties = {};
    properties[GIFT_MARKER_KEY] = 'true';
    properties[GIFT_MESSAGE_KEY] = GIFT_MESSAGE_VALUE;
    var items = [{id: giftVariantId, quantity: 1, properties: properties}];

    if (hasLiquidAjaxCart()) {
      return window.liquidAjaxCart.add({items: items});
    }

    return fetch('/cart/add.js', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({items: items}),
    });
  }

  function setLineQuantity(lineKey, quantity) {
    if (hasLiquidAjaxCart()) {
      return window.liquidAjaxCart.change({id: lineKey, quantity: quantity});
    }

    return fetch('/cart/change.js', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({id: lineKey, quantity: quantity}),
    });
  }

  // Zeroes out a set of gift lines one at a time (not concurrently) so we
  // never fire overlapping /cart/change.js calls against the same cart.
  function removeLines(lines) {
    return lines.reduce(function (promise, line) {
      return promise.then(function () { return setLineQuantity(line.key, 0); });
    }, Promise.resolve());
  }

  // The cart & checkout validation function runs on every cart mutation,
  // not just at checkout. That means a single-line /cart/change.js call
  // that would drop the subtotal below min_subtotal while the gift is
  // still in the cart gets rejected outright - it never reaches our own
  // reactive cleanup in syncGiftLine, because the mutation that would have
  // caused it never applies. A naive "remove the gift once we see this
  // error" fix doesn't work either: as soon as the gift is gone, the cart
  // still qualifies (the customer's own line never actually changed), so
  // our own sync immediately re-adds it - a permanent loop. The only way
  // out is one atomic mutation that changes the customer's line AND
  // removes the gift together, so the cart is self-consistent the moment
  // it lands (doesn't qualify, no gift - nothing left to react to).
  //
  // NOTE: this is a different problem from duplicate gift lines (that's
  // handled by the Cart Transform now) - it can happen with a single,
  // perfectly normal gift line, so it stays here regardless.
  //
  // Deliberately matches ONLY the subtotal-threshold message. A blocked
  // request whose fix is just "drop the gift line" must NOT come through
  // here: the compensating update below would rebuild the exact same
  // request that was just rejected, whose rejection would trigger another
  // retry, forever. The validation function is instead responsible for not
  // blocking removals in the first place (it ignores marked lines that
  // aren't actually free - see cart_validations_generate_run.ts).
  function isGiftThresholdError(status, body) {
    if (status !== 422) return false;
    var message = body && (body.message || body.description);
    return typeof message === 'string' && message.indexOf('qualify for the free gift') !== -1;
  }

  // Three shapes have to be handled, all confirmed live:
  //   1. JSON string body - when we call Liquid Ajax Cart's API directly
  //      (.change()/.update()).
  //   2. FormData keyed by "line" (1-based position in cart.items) and
  //      "quantity" - theme quantity controls that submit a cart form.
  //   3. NO body at all, with the change encoded in the URL query string -
  //      Liquid Ajax Cart's `data-ajax-cart-request-button` attribute, e.g.
  //      `/cart/change.js?line=2&quantity=1`. This is what the Parks theme's
  //      drawer cart uses. Missing this case meant a blocked decrease was
  //      never retried and the customer simply could not lower a quantity
  //      that would drop the subtotal below the threshold.
  // Identifiers also vary: "id" (a line key) or "line" (1-based index).
  function parseChangeRequest(url, init) {
    var fromBody = parseRequestBody(init);
    if (fromBody) return fromBody;
    return parseRequestUrl(url);
  }

  function parseRequestUrl(url) {
    var queryIndex = typeof url === 'string' ? url.indexOf('?') : -1;
    if (queryIndex === -1) return null;

    var params = new URLSearchParams(url.slice(queryIndex + 1));
    var quantity = params.get('quantity');
    if (quantity == null) return null;

    var id = params.get('id');
    if (id) return {id: id, quantity: Number(quantity)};

    var line = params.get('line');
    if (line) return {line: Number(line), quantity: Number(quantity)};

    return null;
  }

  function parseRequestBody(init) {
    if (!init || init.body == null) return null;

    if (typeof init.body.entries === 'function') {
      var map = {};
      Array.from(init.body.entries()).forEach(function (pair) {
        map[pair[0]] = pair[1];
      });
      if (map.quantity == null) return null;
      if (map.id != null) return {id: map.id, quantity: Number(map.quantity)};
      if (map.line != null) return {line: Number(map.line), quantity: Number(map.quantity)};
      return null;
    }

    if (typeof init.body === 'string') {
      try {
        return JSON.parse(init.body);
      } catch (e) {
        return null;
      }
    }

    return null;
  }

  function retryBlockedChangeAsCombinedUpdate(url, init) {
    var originalBody = parseChangeRequest(url, init);
    if (!originalBody || originalBody.quantity == null || (originalBody.id == null && originalBody.line == null)) {
      return;
    }

    getCart().then(function (cart) {
      var targetKey = originalBody.id != null ? originalBody.id : (cart.items[originalBody.line - 1] || {}).key;
      if (!targetKey) return;

      var giftLines = cart.items.filter(isMarkedGiftLine);

      // Nothing to combine: the blocked request was itself only touching a
      // gift line, so the "compensating" update would be byte-for-byte the
      // request that just got rejected - retrying it only loops.
      if (giftLines.some(function (line) { return line.key === targetKey; })) {
        console.log('[GWP] blocked request only touched a gift line, not retrying (would be identical)');
        return;
      }

      var updates = {};
      giftLines.forEach(function (line) {
        updates[line.key] = 0;
      });
      updates[targetKey] = originalBody.quantity;

      console.log('[GWP] cart change blocked by gift threshold validation - retrying as a combined update', updates);

      // Through Liquid Ajax Cart's own public API, not a bare fetch - a
      // bare fetch would change the cart server-side but the library would
      // never learn about it, so its cached cart state and the DOM it's
      // bound to would never update.
      if (hasLiquidAjaxCart()) {
        return window.liquidAjaxCart.update({updates: updates});
      }

      return fetch('/cart/update.js', {
        method: 'POST',
        headers: {'Content-Type': 'application/json', Accept: 'application/json'},
        body: JSON.stringify({updates: updates}),
      });
    });
  }

  // Installed first, before any other cart activity: wraps fetch only to
  // read the body of a blocked /cart/change.js call (Liquid Ajax Cart's
  // own request-end event doesn't expose it) and trigger the compensating
  // update above. It never swaps the response - the original 422 still
  // reaches Liquid Ajax Cart's normal error handling; our corrected
  // /cart/update.js is a separate, immediately-following request that
  // leaves the cart and the UI right where the customer expected them.
  function installGiftThresholdRetry() {
    var originalFetch = window.fetch.bind(window);

    window.fetch = function (input, init) {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      // Matches `/cart/change` as well as `/cart/change.js`: theme markup
      // built with `{{ routes.cart_change_url }}` produces the extension-less
      // form. Matching only the `.js` form silently skipped every request the
      // theme's own quantity buttons make.
      var isCartChange = url.indexOf('/cart/change') !== -1;

      var responsePromise = originalFetch(input, init);
      if (!isCartChange) return responsePromise;

      responsePromise
        .then(function (response) {
          if (response.status !== 422) return;
          return response
            .clone()
            .json()
            .then(function (body) {
              if (isGiftThresholdError(response.status, body)) {
                retryBlockedChangeAsCombinedUpdate(url, init);
              }
            });
        })
        .catch(function () {});

      return responsePromise;
    };
  }

  function syncGiftLine(cartOverride) {
    if (syncing) {
      syncQueued = true;
      return;
    }
    syncing = true;

    Promise.resolve(cartOverride || getCart())
      .then(function (cart) {
        var giftLines = cart.items.filter(isMarkedGiftLine);
        var applies = offerApplies();

        if (!applies) {
          console.log('[GWP] offer does not apply right now (status/country/currency/test mode), cleaning up', {
            status: config.status, country: config.country, currency: config.currency, giftLineCount: giftLines.length,
          });
          if (giftLines.length > 0) {
            var now = Date.now();
            if (now - lastCleanupAttemptAt < CLEANUP_RETRY_COOLDOWN_MS) {
              console.log('[GWP] cleanup already attempted recently, waiting before retrying');
              return;
            }
            lastCleanupAttemptAt = now;
            return removeLines(giftLines);
          }
          return;
        }

        // The gift itself is $0, so it never affects the subtotal - but
        // exclude it explicitly anyway in case a manual price override or
        // discount ever changes that assumption.
        var giftLinesTotal = giftLines.reduce(function (total, item) { return total + item.line_price; }, 0);
        var subtotalExcludingGift = (cart.items_subtotal_price != null ? cart.items_subtotal_price : cart.total_price) - giftLinesTotal;
        var qualifies = subtotalExcludingGift / 100 >= minSubtotal;

        console.log('[GWP] sync', {
          subtotalExcludingGift: subtotalExcludingGift / 100,
          minSubtotal: minSubtotal,
          qualifies: qualifies,
          giftLineCount: giftLines.length,
          cartItems: cart.items.map(function (i) { return {variant_id: i.variant_id, quantity: i.quantity, properties: i.properties}; }),
        });

        if (!qualifies) {
          if (giftLines.length > 0) {
            console.log('[GWP] removing gift, no longer qualifies');
            return removeLines(giftLines);
          }
          return;
        }

        // Qualifies: add the gift if it's missing. If it's already there as
        // a single line, keep its own quantity at 1 (a customer bumping the
        // quantity control on that line shouldn't give them extra gifts).
        // Multiple SEPARATE gift lines are no longer consolidated here -
        // that's the Cart Transform Function's job now (see
        // parks-cart-transformer). If it hasn't run/failed, duplicates can
        // still reach checkout, where the validation function blocks it.
        if (giftLines.length === 0) {
          console.log('[GWP] adding gift');
          return addGift();
        }
        if (giftLines.length === 1 && giftLines[0].quantity !== 1) {
          return setLineQuantity(giftLines[0].key, 1);
        }
      })
      .catch(function (e) {
        console.error('GWP add-to-cart sync failed', e);
      })
      .finally(function () {
        syncing = false;
        if (syncQueued) {
          syncQueued = false;
          syncGiftLine();
        }
      });
  }

  // Preferred path: Liquid Ajax Cart dispatches this after every cart
  // request it performs (its own queue AND ours, since we use its API too),
  // with the fresh cart already in event.detail.cart - no extra fetch,
  // and no risk of racing an in-flight request since everything is queued.
  function watchLiquidAjaxCart() {
    document.addEventListener('liquid-ajax-cart:request-end', function (event) {
      var cart = event.detail && event.detail.cart;
      syncGiftLine(cart);
    });
    document.addEventListener('liquid-ajax-cart:init', function () {
      syncGiftLine();
    });
  }

  // Fallback for themes that don't use Liquid Ajax Cart: listen for the
  // handful of custom cart-update events most themes dispatch, and poll as
  // the last-resort safety net. The poll interval is deliberately long (10s):
  // without a queueing mechanism, a short interval risks colliding with the
  // theme's own in-flight cart request and leaving its cart UI stuck.
  var COMMON_CART_EVENTS = ['cart:updated', 'cart:refresh', 'cart:build', 'cart:change', 'cart:update'];

  function watchCommonCartEvents() {
    COMMON_CART_EVENTS.forEach(function (eventName) {
      document.addEventListener(eventName, function () {
        setTimeout(function () { syncGiftLine(); }, 250);
      });
    });
  }

  function pollCart() {
    setInterval(function () { syncGiftLine(); }, 10000);
  }

  // Installed first, and unconditionally - any cart mutation on the page,
  // by any theme control or app, can hit the threshold deadlock above.
  installGiftThresholdRetry();

  // Registered unconditionally (harmless if unused): Liquid Ajax Cart might
  // not be initialized yet at this exact point even if the theme uses it.
  watchLiquidAjaxCart();
  watchCommonCartEvents();
  pollCart();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { syncGiftLine(); });
  } else {
    syncGiftLine();
  }
})();
