# GWP Cart Transformer — plan y contexto

App extension-only de Shopify: "Gift With Purchase" (regalo gratis al superar un
subtotal mínimo). Basada en la arquitectura de `free-gift-gwp-validation`
(proyecto hermano, mismo repo padre), simplificando la consolidación de líneas
duplicadas del regalo con un Cart Transform Function (`linesMerge`) en vez de
lógica JS en el storefront.

Tienda destino: **confirmado Shopify Plus** (ver "Pivote a Plus" más abajo).
`lineUpdate` / price override en `linesMerge` SÍ se usan, para no depender de
que el merchant configure el variant regalo en $0 manualmente en el catálogo.

## Las 4 extensiones

| Extensión | Handle | Tipo | Rol |
|---|---|---|---|
| Admin action | `parks-admin-action-ui` | `ui_extension` (admin.product-details.action.render) | UI para elegir producto/variant regalo, min_subtotal, status, test mode/tag. Guarda todo en `shop.metafields['$app:gwp']['config']`. Registra la metafield definition (storefront PUBLIC_READ) y activa el Cart Transform (`cartTransformCreate`), ambos de forma idempotente. |
| Theme extension | `parks-theme-extension` | `theme` (app embed block) | Lee el config vía Liquid, lo inyecta en `<script id="gwp-config">`, y el JS agrega/quita la línea del regalo según el subtotal califique o no. |
| Cart Transform Function | `parks-cart-transformer` | `function` (`cart.transform.run`) | 1 línea del `gift_variant_id` → `lineUpdate` la clampa a $0. 2+ líneas → `linesMerge` las fusiona en una Y la clampa a $0 en la misma operación. **Única pieza nueva respecto a la referencia.** |
| Cart & Checkout Validation Function | `parks-cart-checkout-validation` | `function` (`cart.validations.generate.run`) | Server-side enforcement: bloquea el checkout si el regalo está en el carrito y el subtotal no alcanza el mínimo, o si la cantidad total del regalo supera 1. No confía en el JS ni en el transform. |

Metafield compartido por todas: shop metafield `$app:gwp.config` (json):
`status` (active/draft), `min_subtotal`, `gift_variant_id`, `test_mode`,
`test_tag[]`.

Access scopes (`shopify.app.toml`): `read_products, write_products,
read_customers, write_cart_transforms`.

## Decisiones tomadas explícitamente con el usuario (no asumidas)

### 1. `linesMerge` self-referencing — EXPERIMENTAL, sin confirmar en la doc de Shopify

Investigué la doc oficial (`shopify.dev/docs/api/functions/latest/cart-transform`)
y varios issues de `Shopify/function-examples` / `Shopify/shopify-function-javascript`.
Todos los ejemplos reales de `linesMerge` usan un `parentVariantId` **distinto**
de los variants fusionados (patrón de bundle: N componentes → 1 variant bundle
dedicado). Ninguna fuente confirma ni descarta que `parentVariantId` pueda ser
el **mismo** variant que las líneas fusionadas (nuestro caso: 2+ líneas del
mismo variant regalo → 1 línea de ese mismo variant), ni cómo se calcula la
cantidad resultante en ese caso degenerado (asumimos: suma de las cantidades
de las líneas de entrada, ya que es la única lectura razonable del campo
`CartLineInput.quantity`, pero no está documentado).

**Decisión del usuario:** proceder con self-referencing (`parentVariantId =
gift_variant_id`) igualmente, aceptando que es un uso no documentado. Marcado
explícitamente en el código como EXPERIMENTAL. **Antes de confiar en esto en
producción, hay que verificarlo en vivo** con `shopify app dev` contra un
carrito real: agregar el variant regalo dos veces (dos llamadas separadas a
`/cart/add.js` o una app externa) y confirmar que efectivamente colapsa en una
sola línea, y qué cantidad muestra. Los tests locales (vitest +
shopify-function-test-helpers) sólo validan la forma del output contra el
schema — no ejecutan el motor de checkout real, así que no prueban que Shopify
acepte/renderice esto correctamente.

Si la verificación en vivo muestra que no funciona (error, o no fusiona), hay
que revertir esta función a `NO_CHANGES` y devolver la consolidación de
duplicados al JS del storefront (ver más abajo, código removido pero fácil de
restaurar desde `free-gift-gwp-validation`).

### 2. El parche de retry atómico del 422 se MANTIENE (no se elimina)

El plan original asumía que `linesMerge` volvía innecesario tanto (a) consolidar
duplicados en JS como (b) el parche de retry atómico ante 422. Verifiqué que
son dos problemas distintos:

- **(a) Consolidar duplicados** — sí resuelto por `linesMerge`. Se quita del JS.
- **(b) Deadlock del 422** — la validation function puede rechazar un cambio
  de cantidad en la línea **del cliente** (no la del regalo) si ese cambio
  bajaría el subtotal por debajo del mínimo mientras el regalo sigue presente,
  **incluso con una sola línea de regalo, sin ningún duplicado**. `linesMerge`
  no toca este escenario para nada (no hay líneas duplicadas involucradas).
  Eliminar el parche reintroduciría este deadlock (cliente atascado sin poder
  bajar su cantidad).

**Decisión del usuario:** mantener el parche de retry atómico intacto. Sólo se
quita la lógica de "consolidar duplicados" (dejar 1 y borrar el resto).

### 3. Pivote a Plus: se habilita el price-clamp con `lineUpdate`/`linesMerge`

Toda la premisa inicial del proyecto (y el comentario `GWP_LINE_UPDATE_TODO`
que dejamos como flag) asumía que la tienda destino **no** era Plus. El
usuario confirmó después (con captura de `Settings → Plan` mostrando "Plus")
que **sí lo es**. Esto invalida la razón original para no usar `lineUpdate`, y
abre la puerta a que el $0 del regalo ya no dependa de que el merchant
configure manualmente el variant en $0 en el catálogo.

Antes de habilitarlo investigué un detalle importante: un issue reportado en
`Shopify/function-examples#470` documenta que aplicar una operación `update`
Y una `merge` sobre la **misma cart line original** dentro del mismo resultado
de la función hace que Shopify **ignore silenciosamente el cambio de precio**
del update (contradice la documentación oficial, que dice que ambas deberían
aplicarse). Para evitar pisar ese bug, el diseño final NO combina
`lineUpdate` + `linesMerge` sobre la misma línea nunca. En vez de eso:

- **0 o 1 línea de regalo** → `lineUpdate` con
  `price.adjustment.fixedPricePerUnit.amount = "0.00"` sobre esa línea.
- **2+ líneas de regalo** → `linesMerge` con su propio campo
  `price.percentageDecrease.value = "100.0"` (100% de descuento = $0) en la
  MISMA operación de merge, sin ningún `lineUpdate` adicional. Esto logra
  "fusionar + poner a $0" sin nunca combinar dos operaciones distintas sobre
  la misma línea original, que es exactamente el escenario roto del issue
  #470.

**Cosas sin confirmar todavía (pendientes de verificación en vivo, además del
punto 1 de self-referencing `linesMerge`):**
- El formato/escala exacta de `percentageDecrease.value` (asumido 0-100,
  como en las Discount Functions de Shopify; ningún ejemplo oficial de
  `linesMerge`/`merge` con `price` lo confirma con un valor concreto).
- Que `linesMerge` con `price` funcione igual de bien en el caso
  self-referencing (parentVariantId = variant fusionado) que en el caso
  normal de bundle documentado.

Esto significa que **ya no hace falta** que el merchant ponga el variant
regalo en $0 en el catálogo — el $0 ahora lo fuerza la función. Sí sigue
siendo buena práctica tener un variant dedicado exclusivamente al regalo
(oculto, no vendible por otra vía) para que un `lineUpdate`/`linesMerge` con
100% de descuento no termine regalando por error una variante que también se
vende normalmente.

### 4. Marker pivot: transform y validation ahora filtran por `_gwp_gift`

Consecuencia directa del punto 3: como el catálogo ya no es la fuente del $0,
el mismo variant puede tener un precio real (ej. $25) y a la vez tener una
línea clampeada a $0 por la función. Esto significa que ya NO es seguro tratar
"cualquier línea que matchee el variant" como "el regalo" — un cliente que
agrega genuinamente una segunda unidad del mismo variant (sin pasar por el
JS del theme, por ende sin la property `_gwp_gift: true`) espera pagar precio
normal por ella, y no debería:
- que esa línea también se clampe a $0 (regalarla sin querer), ni
- que cuente para las reglas de "subtotal mínimo" / "máximo 1 regalo" y le
  bloquee el checkout con "Only one free gift is allowed" por algo que está
  pagando de verdad.

**Decisión del usuario:** filtrar por el marker `_gwp_gift: true` en AMBAS
funciones (no solo en el transform):
- `parks-cart-transformer`: solo las líneas marcadas se clampan a $0 /
  se fusionan. Cualquier línea del mismo variant sin la marca queda
  completamente intacta, a su precio real de catálogo.
- `parks-cart-checkout-validation`: solo las líneas marcadas cuentan para
  `giftQuantity` (subtotal mínimo y "máximo 1 regalo"). Una línea sin marca
  nunca bloquea el checkout.

Esto revierte una decisión de diseño anterior (match por variant id
ignorando el marker, heredada de cuando el catálogo SIEMPRE tenía el variant
en $0 y no hacía falta distinguir). El riesgo aceptado: alguien con acceso
técnico (API directa, otra app) podría en teoría intentar falsificar la
property `_gwp_gift: true` para regalarse el variant - pero eso ya requiere
salir del flujo normal de storefront/checkout, fuera del alcance de esta app.

El transform ya agrega `_gwp_gift`/`Gift` como attributes al fusionar líneas
duplicadas (`linesMerge.attributes`), así que la línea resultante del merge
sigue estando marcada para que la validation function la siga reconociendo
correctamente después del merge.

### 5. BUG REAL encontrado en vivo: la validation function nunca se ejecutaba

Probando en vivo (`testing-david-plus.myshopify.com`), el usuario reportó que
el checkout dejaba pasar 4 unidades de regalo sin bloquear. Diagnóstico en
`.shopify/logs`: **53 invocaciones registradas de `parks-cart-transformer`,
0 de `parks-cart-checkout-validation`, nunca** - la función ni siquiera se
estaba ejecutando (no era un bug de lógica en `cartValidationsGenerateRun`).

Causa raíz: a diferencia de la referencia `free-gift-gwp-validation` (que
tampoco lo tenía y probablemente nunca se probó en vivo), a esta función le
faltaba una activación explícita vía la mutación `validationCreate` -
exactamente el mismo tipo de paso que `cartTransformCreate` hace para el Cart
Transform, pero para functions de tipo `cart.validations.generate.run`.
Sin esa llamada, la extensión se compila y se registra en el bundle (se ve en
`.shopify/dev-bundle/manifest.json`), pero Shopify nunca la invoca.

Arreglado:
- Scope `write_validations` agregado a `shopify.app.toml` (requerido por
  `validationCreate`).
- `ensureCartValidationActive()` en `ActionExtension.jsx`: primero consulta
  `validations(first: 50) { nodes { shopifyFunction { handle } } }` para ver
  si ya existe una Validation con `handle: "parks-cart-checkout-validation"`
  (no hay un código de error "ya existe" confirmado para `validationCreate`,
  así que se evita duplicar validaciones - el store tiene un tope de 25). Si
  no existe, llama `validationCreate` con `enable: true, blockOnFailure: true`.
  Se ejecuta en cada guardado, junto a `ensureStorefrontMetafieldAccess` y
  `ensureCartTransformActive`.

**Acción pendiente para que esto tome efecto:** el nuevo scope
`write_validations` requiere reinstalar/reautorizar la app en la tienda de
desarrollo, y después volver a abrir la Admin Action del producto y darle
"Save" una vez más (para que `ensureCartValidationActive()` se ejecute y
active la validación). Sin ese re-save, la validation function seguirá sin
activarse aunque el código ya esté correcto.

## Qué cambia respecto a `free-gift-gwp-validation`

- **Admin action**: código reutilizado casi verbatim + se agrega
  `ensureCartTransformActive()` (idéntico en espíritu al commit `79ebec7` del
  proyecto de referencia, adaptado al handle `parks-cart-transformer`).
- **Theme extension JS**: se elimina `installGiftThresholdRetry` NO — eso se
  queda. Se elimina únicamente el branch `giftLines.length > 1` (consolidar
  duplicados) de `syncGiftLine`. Se conserva el ajuste de cantidad a 1 cuando
  hay exactamente una línea de regalo con cantidad ≠ 1 (no es lo mismo que
  "consolidar duplicados": no hay ninguna otra línea involucrada, así que no
  reintroduce el problema del retry atómico).
- **Cart Transform Function**: nueva, y con price-clamp activo (ver "Pivote a
  Plus" arriba) — la tienda destino confirmó ser Plus, así que sí se usa
  `lineUpdate`/`linesMerge` con `price` para forzar el $0 server-side, evitando
  depender de que el catálogo tenga el variant en $0.
- **Cart & Checkout Validation Function**: lógica de negocio sin cambios
  (sigue sumando la cantidad de TODAS las líneas que matcheen el
  `gift_variant_id`, marcadas o no — esto YA es equivalente a "revisar la
  cantidad de la única línea fusionada" cuando el merge funciona, y sigue
  siendo la defensa correcta si el merge experimental fallara). Se documenta
  esta razón en un comentario para que quede explícito que es una decisión, no
  un olvido.

## Estado de implementación

Ver TaskList de la sesión. Extensiones ya scaffoldeadas por el CLI con handles
correctos (`parks-admin-action-ui`, `parks-theme-extension`,
`parks-cart-transformer`, `parks-cart-checkout-validation`) — falta reemplazar
el contenido placeholder por la lógica real descrita arriba.
