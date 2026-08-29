# @itick/ingest

SDK Node pour **pousser des reçus vers ITICK**. ITICK reçoit vos tickets et
factures, les certifie (Factur-X, RFC3161, PAF) et les route vers le bon
utilisateur final.

Zéro dépendance (`fetch` natif, Node ≥ 18). TypeScript inclus : les types sont
le miroir du contrat serveur — un payload que le compilateur accepte est un
payload que le serveur accepte.

Documentation de référence : [guide d'intégration](https://itick.fr/partenaires/documentation) ·
[Swagger public](https://api.itick.fr/itick/partner/docs) ·
[contrat OpenAPI brut](https://api.itick.fr/itick/partner/docs/spec.yml).

## Installation

Le paquet n'est pas (encore) publié sur npm : installez-le depuis ce dépôt.

```bash
# depuis votre projet, chemin relatif vers sdk-node/
npm install file:../itick-integrations/sdk-node
```

`dist/` n'est pas versionné : le script `prepare` du paquet le compile
automatiquement à l'installation. Pour le construire à la main :
`npm ci && npm run build` dans `sdk-node/`.

## Quickstart

Payload complet : les six champs requis du mode structuré sont tous présents.

```ts
import { ItickClient } from '@itick/ingest';

const itick = new ItickClient({ apiKey: process.env.ITICK_API_KEY! });

const result = await itick.pushReceipt({
  date: new Date().toISOString(),
  merchantSiret: '12345678901234',
  merchantName: 'Le Café du Coin',
  merchantEmail: 'contact@lecafe.fr',
  merchantPhone: '+33100000000',
  items: [{ name: 'Expresso', quantity: 2, unitPriceHt: 1.5, vatRate: 10 }],
  customerEmail: 'client@example.com',
  externalId: 'ticket-2026-08-29-0001',
});

console.log(result.receiptId, result.invoiceNumber, result.totals?.totalTtc);
```

Ce bloc est extrait tel quel par la suite de tests et passe `tsc --strict`.
La clé API (sandbox `itick_sandbox_…`, production `itick_…`) s'obtient auprès
d'ITICK ; la sandbox n'a pas d'effet comptable.

## Champs requis

Le serveur détecte le mode d'après les champs envoyés (aucun champ « mode ») :

| Mode | Détection | Requis | Type SDK |
|---|---|---|---|
| **Structuré** (recommandé) | `items` présent | `date`, `merchantSiret`, `merchantName`, `merchantEmail`, `merchantPhone`, `items` (≥ 1 ligne) | `StructuredReceipt` |
| **Document** | `items` absent, `documentPdf` présent | `documentPdf` (base64 strict, 10 Mo décodés max) | `DocumentReceipt` |
| aucun des deux | — | → `400 MODE_REQUIRED` | — |

Un champ requis absent → `400 VALIDATION_ERROR` avec `details[]` (`field`,
`errors`) ; le SDK les expose sur `ItickIngestError.details`. Chaque ligne
(`ReceiptItem`) exige `name`, `quantity` (≥ 1), `unitPriceHt` (≥ 0), `vatRate`
(≥ 0). ITICK calcule totaux et TVA depuis `items` : aucun total à déclarer.

Champs facultatifs typés (voir la JSDoc de `StructuredReceipt`) :
`paymentMethod`, `operatorId`, `customerEmail` **ou** `customerPhone` (pas les
deux), `externalId`, `generateQr`, `documentPdf` (document original joint),
enrichissement commerçant (`merchantLogo`, `merchantVatNumber`,
`merchantAddress`, `merchantNafCode`, `merchantLegalForm`), et les champs
EN16931 (`buyerName`, `buyerSiret`, `buyerVatNumber`, `buyerAddress`,
`sellerVatNumber`, `sellerAddress`, `deliveryDate`, `dueDate`,
`paymentAccountIban`, `paymentAccountBic`, `purchaseOrderRef`, `contractRef`,
`documentTypeCode`, `taxCategoryCode`, `taxExemptionReason`, `paymentTerms` ;
par ligne : `description`, `discount`, `sku`, `unitOfMeasure`,
`taxCategoryCode`, `itemIdentifier`, `buyerItemIdentifier`).

Les dates acceptent une chaîne ISO 8601 ou un objet `Date`.

### Mode document (vous n'avez qu'un PDF ou une image)

```ts
import { readFileSync } from 'node:fs';

// depuis des octets bruts (le SDK encode en base64 pour vous)
await itick.pushDocument(readFileSync('ticket.pdf'), {
  customerEmail: 'client@example.com',
  totalTtc: 12.5, // indice OCR ; si le document est illisible, un brouillon minimal est créé
});

// ou directement avec un base64 que vous avez déjà
await itick.pushReceipt({ documentPdf: '<base64…>', customerEmail: 'client@example.com' });
```

Indices facultatifs en mode document : `merchantName`, `date`, `totalTtc`,
`externalId`, `generateQr`, `operatorId`. Document illisible → `422
DOCUMENT_UNREADABLE` (`receiptId` présent sur l'erreur si `totalTtc` a permis
un brouillon).

## Idempotence et déduplication

Deux mécanismes distincts, cumulables :

1. **`externalId` — LA clé recommandée.** Votre identifiant unique de
   ticket/facture. Déduplication scopée à votre compte et à l'environnement :
   un second envoi du même `externalId` renvoie `409 DUPLICATE_RECEIPT_DETECTED`
   avec `existingReceiptId`. Sa présence **désarme le filet heuristique** du
   serveur (« même commerçant, même montant, même jour ») : deux ventes
   distinctes au même montant le même jour passent. Sans `externalId`, ce filet
   s'applique. Fournissez-le toujours.
2. **En-tête `Idempotency-Key`** (`opts.idempotencyKey`, 256 caractères max).
   Le serveur rejoue la réponse à l'identique pendant 24 h pour la même clé et
   le même corps (`422 IDEMPOTENCY_KEY_REUSED` si le corps diffère ; `409
   IDEMPOTENCY_KEY_IN_PROGRESS` si la première requête est encore en cours — le
   SDK le rejoue lui-même, avec la même clé). Si vous n'en donnez pas, le SDK génère
   un UUID **par appel** : il couvre les retries du SDK, pas ceux de votre
   propre process. Pour survivre à un redémarrage, passez votre clé :

```ts
await itick.pushReceipt(receipt, { idempotencyKey: 'commande-123' });
```

## Batch et statuts par item

```ts
const batch = await itick.pushBatch([receiptA, receiptB /* … jusqu'à 100 */]);

console.log(batch.httpStatus); // 200 si tout est créé, 207 sinon
for (const r of batch.results) {
  if (r.status === 'created') console.log(r.index, r.receiptId, r.invoiceNumber);
  else console.log(r.index, r.error, r.message, r.details, r.existingReceiptId);
}
```

Chaque item passe la même logique que la route unitaire (dédup, certification,
matching). Un item en erreur **n'interrompt pas** le lot et **ne fait pas
rejeter** `pushBatch` : lisez `results[i].status` (`'created'` | `'error'`) ;
un item en erreur porte `error`, `message`, et selon le code `details[]`
(`VALIDATION_ERROR`), `existingReceiptId` (`DUPLICATE_RECEIPT_DETECTED`) ou
`receiptId` (`DOCUMENT_UNREADABLE` avec brouillon). `pushBatch` ne rejette que
si l'**enveloppe** est refusée (`400` : `receipts` absent, vide ou > 100) ou
sur erreur transitoire après épuisement des retries. L'idempotence par item
passe par `externalId` ; l'en-tête `Idempotency-Key` couvre le lot entier.

## Retry

Par défaut, chaque appel fait jusqu'à **3 nouvelles tentatives** après un échec
**transitoire**, avec une attente de 500 ms, puis 2 s, puis 5 s — chacune
portant un **jitter de ±20 %**, pour que tous les intégrateurs ne réessaient pas
à la même seconde après un incident. Un en-tête `Retry-After` (429 ou 503)
prime sur cette attente, borné à 30 s.

Sont transitoires : une erreur réseau, un timeout, un `5xx`, un `429`, et le
`409 IDEMPOTENCY_KEY_IN_PROGRESS` — c'est précisément l'état que provoque le
retry du SDK quand la première tentative a dépassé le timeout pendant que le
serveur travaillait encore : le rejeu récupère la réponse au lieu de vous
rendre une erreur pour un reçu qui existe. Tout autre `4xx` est définitif
(`400`, `409` doublon, `422`), et une exception qui n'est pas une coupure
réseau (bug de programmation, `baseUrl` invalide, redirection refusée) est
relancée immédiatement plutôt que rejouée en pure perte.

Toutes les tentatives d'un même appel portent la **même `Idempotency-Key`** :
si la première a abouti côté serveur malgré le timeout, la suivante reçoit la
réponse rejouée, jamais un doublon. C'est ce qui rend le retry sûr.

```ts
new ItickClient({ apiKey: '…', retries: 0 }); // désactive le retry
```

## Gestion des erreurs

```ts
import { ItickIngestError } from '@itick/ingest';

try {
  await itick.pushReceipt(receipt);
} catch (e) {
  if (e instanceof ItickIngestError) {
    // e.code : MODE_REQUIRED | VALIDATION_ERROR | INVALID_CHANNEL | DUPLICATE_RECEIPT_DETECTED
    //          | DOCUMENT_UNREADABLE | DOCUMENT_PDF_TOO_LARGE | UNSUPPORTED_DOCUMENT_FORMAT …
    // Côté SDK : INVALID_RESPONSE (réponse hors contrat), NON_JSON_RESPONSE,
    // RESPONSE_TOO_LARGE.
    if (e.code === 'DUPLICATE_RECEIPT_DETECTED') {
      console.log('déjà reçu :', e.existingReceiptId);
    } else if (e.code === 'VALIDATION_ERROR') {
      console.error(e.details); // [{ field: 'merchantPhone', errors: [...] }]
    } else {
      console.error(e.status, e.code, e.message);
    }
  } else {
    // erreur réseau / timeout après épuisement des retries
    throw e;
  }
}
```

## Options du client

```ts
new ItickClient({
  apiKey: '…',
  baseUrl: 'https://api.itick.fr/itick', // défaut ; https OBLIGATOIRE
  timeoutMs: 30_000,                     // défaut, par tentative ; entier > 0
  retries: 3,                            // défaut ; 0 pour désactiver, 10 au plus
  // fetch: customFetch,                 // pour les tests / environnements custom
});
```

Une option invalide lève **à la construction**, pas au premier appel :
`baseUrl` non-`https` (seul `http://localhost`, `127.0.0.1` ou `::1` est toléré
en développement), `timeoutMs` nul ou négatif, `retries` hors bornes, `apiKey`
contenant un caractère intransmissible dans un en-tête HTTP.

## Ce que le SDK garantit sur votre clé API

- **Elle ne sort pas du client.** `console.log(client)`, `JSON.stringify(client)`,
  `util.inspect`, le spread et tout rapporteur d'erreurs qui sérialise son
  contexte n'affichent que `[redacted]`.
- **Elle n'apparaît dans aucun message d'erreur**, même partiellement : une clé
  mal formée est refusée sans que sa valeur soit reproduite.
- **Elle ne part qu'en `https`** et ne suit **aucune redirection**
  (`redirect: 'error'`) : ni la clé ni le corps du reçu (e-mail client, SIRET,
  montants) ne peuvent être expédiés vers un autre hôte.

## Ce que le SDK garantit sur la réponse

- Un `2xx` qui ne porte pas le champ pivot du contrat (`receiptId`, ou
  `results[]` pour un lot) lève `INVALID_RESPONSE` : un proxy d'entreprise ou un
  portail captif qui répond `200` + HTML ne peut pas vous faire croire que le
  reçu est créé.
- Le `timeoutMs` couvre **aussi la lecture du corps** (un serveur qui envoie les
  en-têtes puis se tait ne bloque pas l'appel), et le corps est borné à 1 Mo.
- Un corps non-JSON n'est **jamais** promu en message d'erreur : le message
  reste borné, et un extrait de 256 caractères est isolé sur
  `ItickIngestError.rawBody` — une page d'erreur d'infrastructure ne se déverse
  pas dans vos logs.

## Développement

```bash
npm ci
npm run typecheck   # tsc strict
npm run build       # → dist/
npm test            # compile les tests puis node --test
```

## Référence API

Le contrat complet est public : schéma `PushReceiptRequest` de l'OpenAPI ITICK,
[Swagger](https://api.itick.fr/itick/partner/docs) ·
[spec brute](https://api.itick.fr/itick/partner/docs/spec.yml).

## Licence

MIT
