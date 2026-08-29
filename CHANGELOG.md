# Journal des modifications

Ce dépôt contient deux paquets versionnés indépendamment. **Aucun n'a été
publié sur npm et aucune version n'est marquée par un tag git** : les numéros
ci-dessous sont ceux des `package.json`, les dates celles des commits.

Tant que les paquets sont en `0.x`, une version mineure peut casser les types.

---

## `@itick/ingest` — [`sdk-node/`](sdk-node)

### 0.3.0 — 2026-08-29

Durcissement de sécurité avant la publication du dépôt. **Deux changements de
comportement cassants** : une `baseUrl` en `http://` et une réponse `2xx` hors
contrat lèvent désormais une erreur au lieu de passer silencieusement.

- **La clé API ne sort plus du client.** Champ privé, `toJSON()` et inspection
  personnalisés : `console.log(client)`, `JSON.stringify(client)` et
  `util.inspect` affichent `[redacted]`. Une clé mal formée est refusée à la
  construction, et ni le message d'erreur ni la pile n'en contiennent la valeur.
- **`https` exigé** sur `baseUrl` (`http://localhost`, `127.0.0.1` et `::1`
  restent tolérés pour le développement) : une adresse en clair envoyait la clé
  sur le réseau. Les redirections ne sont plus suivies — le corps du reçu
  (e-mail client, SIRET, montants) ne peut plus partir vers un autre hôte.
- **Plus de résultat inventé.** Une réponse `2xx` sans champ pivot lève
  `INVALID_RESPONSE` au lieu de rendre `receiptId: undefined`. Le corps est lu
  DANS la fenêtre du délai d'attente (un serveur qui envoyait les en-têtes puis
  se taisait bloquait indéfiniment) et borné.
- **Rejeu plus juste** : `409 IDEMPOTENCY_KEY_IN_PROGRESS` est désormais rejoué
  avec la même clé — c'est précisément l'état transitoire que l'idempotence
  couvre. `Retry-After` est respecté, le backoff porte une part d'aléa.
  Une erreur de programmation n'est plus prise pour une panne réseau.
- `timeoutMs` et `retries` sont validés ; script `prepare` : `npm install`
  depuis ce dépôt produit enfin un paquet utilisable.

### 0.2.0 — 2026-08-29

Le SDK ne décrivait pas le contrat réel du serveur : le quickstart du README
produisait une réponse `400 VALIDATION_ERROR`. Cette version aligne les types
sur l'API. **Changements de types cassants.**

- **Champs requis.** En mode structuré, `date`, `merchantSiret`,
  `merchantName`, `merchantEmail`, `merchantPhone` et `items` deviennent
  obligatoires (ils étaient facultatifs) ; en mode document, `documentPdf`
  seul. `PushReceiptInput` remplace `PushInput`, conservé comme alias déprécié.
- **Champs facultatifs typés** : moyen de paiement, opérateur, identité
  acheteur/vendeur EN 16931, dates, IBAN/BIC, références, et par ligne
  description, remise, SKU, unité, code de catégorie de TVA.
- **Lots** : réponse typée avec le statut HTTP réel (200 ou 207) et une union
  discriminée par item (créé / en erreur, avec `details[]` et
  `existingReceiptId`). `externalId` est documenté comme la clé d'idempotence
  recommandée.
- **Retry borné** : 3 nouvelles tentatives (500 ms, 2 s, 5 s) sur erreur
  réseau, expiration, 5xx ou 429 — jamais sur un autre 4xx. Une seule
  `Idempotency-Key` par appel, réutilisée à chaque tentative, donc pas de
  doublon. `retries: 0` désactive le mécanisme.
- **Les tests ne s'exécutaient pas** : `npm test` lançait `node --test` sur des
  fichiers `.test.ts` que Node ne découvre pas, et rapportait donc zéro test.
  Ils sont désormais compilés puis exécutés (15 tests), dont un test qui
  compile le quickstart du README en `tsc --strict`.
- README : sections « Champs requis », « Idempotence et déduplication »,
  « Lots et statuts par item », « Retry ». Un lien Swagger qui répondait 404 a
  été retiré.

### 0.1.0 — 2026-07-06

Première version : `ItickClient` (`pushReceipt`, `pushBatch`, `pushDocument`),
erreurs typées `ItickIngestError`, modes structuré et document, zéro dépendance
d'exécution (`fetch` natif, Node ≥ 18), types TypeScript inclus.

---

## `@itick/stripe-connector` — [`stripe-connector/`](stripe-connector)

### 0.2.0 — 2026-08-29

**Règle posée : une facture que le connecteur ne sait pas représenter
fidèlement est REFUSÉE, jamais approximée.** ITICK est un service de
facturation ; un exemple destiné à être copié ne peut pas produire de
comptabilité fausse. Chaque refus porte un code stable et un motif journalisé.

- **Plus de TVA inventée** (`VAT_RATE_UNKNOWN`) : 20 % étaient appliqués
  d'office à toute ligne sans taux — y compris pour un commerçant en franchise.
  Un taux par défaut doit désormais être posé sciemment.
- **Devise** (`UNSUPPORTED_CURRENCY`) : le contrat d'ingestion ne porte pas de
  devise ; une facture non-EUR était certifiée comme si c'était des euros.
- **Arrondi** : le prix unitaire était arrondi avant multiplication, si bien que
  le total certifié divergeait de celui de Stripe. Le montant de ligne est
  désormais reconstitué au centime.
- **Lignes négatives** (`NEGATIVE_LINE`) : un prorata d'abonnement ou un avoir
  était perdu en silence.
- **Test et production** (`LIVEMODE_MISMATCH`) : un événement Stripe de test
  pouvait être certifié comme une facture réelle.
- Serveur : adresse d'écoute configurable (`127.0.0.1` par défaut), dépassement
  de taille signalé par un `413` explicite, message d'erreur constant pour un
  appelant non authentifié, et un horodatage non numérique ne neutralise plus
  la fenêtre anti-rejeu.

### Antérieurement, non publié

Ces changements sont dans le dépôt mais le numéro de version n'a pas été
incrémenté.

- Alignement sur le SDK 0.2.0 : `mapInvoice` produisait un reçu sans
  `merchantPhone`, que le serveur rejette. `MERCHANT_SIRET`, `MERCHANT_EMAIL`
  et `MERCHANT_PHONE` deviennent des variables d'environnement requises.
- `retries: 0` sur le client ITICK : c'est Stripe qui rejoue le webhook quand
  le connecteur répond 500.

### 0.1.0 — 2026-07-08

Première version : vérification de la signature Stripe sur le corps brut
(HMAC-SHA256 en temps constant, fenêtre anti-rejeu de 5 minutes, sans dépendre
du SDK Stripe), mapping d'une facture Stripe vers un reçu structuré ITICK,
push idempotent (clé d'idempotence = identifiant de l'événement Stripe,
`externalId = stripe-invoice-<id>`), serveur `node:http` sans dépendance,
codes de réponse calibrés pour les rejeux Stripe.

---

## Dépôt

### 2026-08-29 — préparation à la publication en dépôt public

Gouvernance et fichiers d'accueil, sans toucher au code des paquets : licence
MIT (absente jusque-là alors que les `package.json` la déclaraient), README
racine, `SECURITY.md`, `CONTRIBUTING.md`, ce journal, intégration continue
GitHub Actions (actions épinglées par SHA), Dependabot hebdomadaire, gabarits
d'issue et de pull request, `.gitignore` complété (toutes les variantes
`.env`), métadonnées des `package.json` (`repository`, `bugs`, `homepage`).
