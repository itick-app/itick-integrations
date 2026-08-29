# @itick/stripe-connector

Connecteur de référence **Stripe → ITICK**. Vous facturez via Stripe ? À chaque
facture payée, ce service la transfère automatiquement à ITICK, qui la **certifie**
(Factur-X, RFC3161, PAF) et la **route au bon client final** (matching par email).

Zéro dépendance serveur (`node:http` + `node:crypto`), il s'appuie sur le SDK
officiel [`@itick/ingest`](../sdk-node) pour l'envoi.

## Comment ça marche

```
Stripe (invoice.paid) ──webhook signé──▶ connecteur ──@itick/ingest──▶ ITICK
                                              │
                        vérifie la signature Stripe (anti-rejeu)
                        mappe la facture → reçu structuré ITICK
                        pousse avec idempotence (= id de l'événement Stripe)
```

1. **Vérification de signature.** L'en-tête `Stripe-Signature` (`t=…,v1=…`) est
   validé sur le corps **brut** (HMAC-SHA256), en temps constant, avec une fenêtre
   de fraîcheur de 5 min (anti-rejeu). Corps re-sérialisé = signature cassée : c'est
   pourquoi on lit le raw body à la main (piège n°1 des webhooks).
2. **Mapping.** Chaque ligne de la facture Stripe devient une ligne de reçu ITICK
   (`name`, `quantity`, `unitPriceHt`, `vatRate`), avec un total reconstitué au
   centime. Une facture que le mapping ne sait pas représenter fidèlement est
   **refusée** plutôt que certifiée faussement — voir *Ce que le connecteur
   refuse de certifier*.
3. **Push idempotent.** L'`idempotencyKey` = l'id de l'événement Stripe : un retry
   Stripe ne crée jamais de doublon. En plus, `externalId = stripe-invoice-<id>`
   déduplique côté ITICK même entre deux events distincts sur la même facture.

## Démarrage

```bash
cd itick-integrations/stripe-connector
npm install
cp .env.example .env      # renseignez ITICK_API_KEY + STRIPE_WEBHOOK_SECRET
npm run build
npm start
```

Puis, dans le Dashboard Stripe → **Developers → Webhooks → Add endpoint** :
- URL : `https://votre-domaine/webhooks/stripe`
- Événement : `invoice.paid`
- Copiez le **Signing secret** (`whsec_…`) dans `STRIPE_WEBHOOK_SECRET`.

### Tester en local (Stripe CLI)

```bash
stripe listen --forward-to localhost:3000/webhooks/stripe
# le CLI affiche un whsec_… → mettez-le dans .env
stripe trigger invoice.paid
```

⚠️ Le `whsec_…` du CLI est un secret de **test** : utilisez-le avec une clé
ITICK **sandbox** (`itick_sandbox_…`). Avec une clé de production, l'événement
est refusé (`LIVEMODE_MISMATCH`) — c'est voulu : sinon une facture fictive
serait certifiée sous votre vrai SIRET et routée à un client.

Le connecteur log `facture in_… → reçu ITICK r_… (matched=…)`.

## Configuration

Tout passe par l'environnement (voir [.env.example](.env.example)). Variables
**requises** : `ITICK_API_KEY`, `STRIPE_WEBHOOK_SECRET`, et l'identité émetteur
`MERCHANT_SIRET` / `MERCHANT_EMAIL` / `MERCHANT_PHONE` (ITICK les exige en mode
structuré — sans elles, chaque push serait rejeté en `400 VALIDATION_ERROR`).

| Variable | Défaut | Rôle |
|---|---|---|
| `ITICK_API_KEY` | — | Clé API ITICK (sandbox ou prod). |
| `STRIPE_WEBHOOK_SECRET` | — | Secret de signature Stripe. |
| `STRIPE_EVENTS` | `invoice.paid` | Événements traités (CSV). |
| `ITICK_BASE_URL` | `https://api.itick.fr/itick` | Base URL ITICK (**https obligatoire**). |
| `HOST` | `127.0.0.1` | Interface d'écoute. Boucle locale par défaut : le service n'a pas de TLS. **Dans un conteneur, posez `0.0.0.0`** (et ne publiez le port que derrière votre proxy). |
| `PORT` | `3000` | Port d'écoute. |
| `WEBHOOK_PATH` | `/webhooks/stripe` | Chemin du webhook. |
| `MERCHANT_NAME` | `account_name` Stripe | Votre raison sociale. |
| `MERCHANT_SIRET` / `MERCHANT_EMAIL` / `MERCHANT_PHONE` | — | Identité émetteur (requis). |
| `DEFAULT_VAT_RATE` | *aucun* | TVA des lignes **sans** taux Stripe. Sans elle, ces factures sont **refusées** (voir ci-dessous). `0` = franchise en base. |

## Ce que le connecteur refuse de certifier

Le document produit par ITICK est **certifié** (Factur-X, RFC3161, PAF), donc
scellé. La règle de ce connecteur est donc : **mieux vaut refuser une facture
qu'on ne sait pas représenter fidèlement que la certifier faussement.** Aucune
valeur n'est inventée. Un refus est journalisé en `error` avec son motif, et
acquitté `200` à Stripe (rejouer n'y changerait rien) :

| Code | Cas | Pourquoi c'est un refus |
|---|---|---|
| `UNSUPPORTED_CURRENCY` | `invoice.currency` ≠ `eur` | Le contrat d'ingestion ITICK **ne porte pas de devise** : une facture en USD serait certifiée en euros. Et l'exposant Stripe varie (JPY/KRW 0 décimale, KWD/TND 3) : `/100` donnerait un montant faux d'un facteur 10 ou 100. |
| `VAT_RATE_UNKNOWN` | Une ligne sans `tax_rates` exploitable et pas de `DEFAULT_VAT_RATE` | Le connecteur **n'invente pas de TVA**. Un commerçant en franchise en base se retrouverait avec une facture certifiée portant une TVA qu'il n'a jamais collectée. Posez `DEFAULT_VAT_RATE` en connaissance de cause (`0` en franchise). |
| `MULTIPLE_TAX_RATES` | Plusieurs `tax_rates` sur une même ligne | Une ligne ITICK ne porte qu'un taux : n'en garder qu'un fausserait la TVA. |
| `NEGATIVE_LINE` | Une ligne à montant négatif (prorata d'abonnement, avoir) | ITICK exige `unitPriceHt >= 0` en mode structuré ; un avoir est un **document distinct** (EN16931 `381`), hors périmètre de ce connecteur. La facture est à traiter à la main. |

**Ces factures ne sont pas certifiées.** Surveillez ces lignes de log : c'est la
seule trace. Stripe ne les rejouera pas.

## Fidélité des montants

- **Totaux exacts.** ITICK recalcule le total depuis `quantity × unitPriceHt` :
  le mapping garantit que ce produit reconstitue **au centime** le
  `line.amount` de Stripe. Quand le montant ne se divise pas exactement par la
  quantité (10 000 c / 7), la ligne est **regroupée** — quantité `1` au montant
  exact, quantité d'origine reportée dans le libellé (`Appels (× 7)`) et dans
  la description. Arrondir le prix unitaire avant de multiplier ferait diverger
  le document certifié du montant réellement encaissé (et annulait même les
  lignes dont le prix unitaire tombait sous 0,5 centime).
- **Mode test / production.** Le connecteur compare le `livemode` de
  l'événement Stripe au monde de votre clé ITICK (`itick_sandbox_…` = test,
  toute autre = production) et **refuse** la combinaison croisée
  (`LIVEMODE_MISMATCH`) : un `stripe trigger invoice.paid` ne peut plus
  certifier une facture fictive sous votre vrai SIRET.

## Hypothèses restantes (à vérifier selon votre compte Stripe)

- **Montants en centimes d'euro** (division par 100) — garanti par le refus des
  autres devises.
- **Taxe exclusive** (défaut Stripe) : `line.amount` = HT. Si votre compte
  facture en **taxe inclusive**, `unitPriceHt` sera surévalué → adaptez
  `mapInvoice.ts`. Le connecteur ne sait pas détecter ce réglage.

## Réponses & retries

Le connecteur répond à Stripe de façon à ne jamais boucler inutilement :

| Situation | HTTP | Effet Stripe |
|---|---|---|
| Reçu poussé | 200 | ✔ |
| Doublon ITICK (409) | 200 | ✔ (idempotent) |
| Facture non représentable (voir tableau des refus) | 200 | ✔ pas de retry, **facture NON certifiée**, logué en `error` |
| Mode test / production croisés | 200 | ✔ pas de retry, refusé, logué en `error` |
| Payload rejeté (4xx ITICK) | 200 | ✔ pas de retry (non rejouable), **facture NON certifiée**, logué |
| Panne réseau / 5xx ITICK | 500 | 🔁 Stripe rejoue automatiquement (retry du SDK désactivé : `retries: 0`) |
| Signature invalide | 400 | 🔁 (indique une mauvaise config) — corps `{ "error": "INVALID_SIGNATURE" }`, sans détail |
| Corps > 1 Mo | 413 | ✔ refus définitif (une socket coupée serait rejouée en boucle) |
| Événement non abonné | 200 | ✔ ignoré |

## Sécurité

- La signature Stripe est **toujours** vérifiée (`whsec_…` obligatoire),
  en temps constant, avec une fenêtre de fraîcheur de 5 min (anti-rejeu). Un
  horodatage non numérique est **refusé** : accepté, il désarmerait cette
  fenêtre en silence.
- **Ce service ne fait pas de TLS.** Stripe n'appelle que du `https` : placez-le
  derrière un reverse-proxy (nginx, Caddy, Traefik) qui termine le TLS, et
  gardez `HOST=127.0.0.1` — ou, en conteneur, `HOST=0.0.0.0` avec un port publié
  uniquement vers le proxy. N'exposez jamais le port en direct sur Internet.
- Une réponse d'erreur ne renvoie **aucun détail de configuration** : le motif
  d'un refus de signature reste dans vos logs, sinon un tiers non authentifié
  pourrait savoir si le secret est configuré et mesurer votre décalage d'horloge.
- Le processus détient une clé API ITICK en mémoire : `.env` en `chmod 600`,
  hors de l'image Docker (montez-le ou passez par le gestionnaire de secrets),
  et faites tourner le `whsec_…` depuis le Dashboard Stripe en cas de doute.
- En production, `stripe.webhooks.constructEvent` (SDK Stripe officiel) est une
  alternative ; on l'implémente ici sans dépendance pour rester léger et explicite.

## Développement

```bash
npm run typecheck   # tsc strict
npm test            # mapping, signature, serveur end-to-end
```

## Périmètre

Connecteur **de référence** : simple, lisible, adaptable. Il couvre le cas « facture
payée → reçu certifié chez le client ». Pour d'autres flux (remboursements,
avoirs, paiements one-shot sans facture), étendez `STRIPE_EVENTS` + `mapInvoice.ts`.
