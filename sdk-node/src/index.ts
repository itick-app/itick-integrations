/**
 * @itick/ingest — SDK Node pour pousser des reçus vers ITICK.
 *
 * ITICK reçoit vos reçus/tickets, les certifie (Factur-X, RFC3161, PAF) et les
 * route vers le bon utilisateur final. Deux façons d'envoyer :
 *   - structuré : vous donnez les lignes (`items`), ITICK calcule TVA & totaux ;
 *   - document  : vous donnez juste un PDF/image, ITICK le lit (OCR).
 *
 * Les types de ce fichier sont le MIROIR du schéma public `PushReceiptRequest`
 * de l'OpenAPI ITICK (https://api.itick.fr/itick/partner/docs/spec.yml) : ce
 * que le compilateur accepte, le serveur l'accepte ; ce qu'il refuse (champ
 * requis absent) produirait un `400 VALIDATION_ERROR` réel.
 *
 * Zéro dépendance : `fetch` natif (Node >= 18).
 */
import { randomUUID } from 'node:crypto';

export const SDK_VERSION = '0.2.0';

// ---------------------------------------------------------------------------
// Types de requête (miroir de POST /receipts/providers)
// ---------------------------------------------------------------------------

/** Moyen de paiement (enum serveur `PaymentMethod`). */
export type PaymentMethod = 'card' | 'cash' | 'mobile' | 'check' | 'transfer' | 'other';

/**
 * Date au format ISO 8601 (`2026-08-29T10:00:00Z`) ou objet `Date` —
 * `JSON.stringify` le sérialise en ISO, c'est ce que le serveur attend.
 */
export type DateInput = string | Date;

/** Adresse (EN16931) — tous les champs sont facultatifs, 255 caractères max. */
export interface Address {
  street1?: string;
  street2?: string;
  city?: string;
  postalCode?: string;
  country?: string;
}

/** Une ligne du reçu (mode structuré). */
export interface ReceiptItem {
  /** Libellé de la ligne (255 caractères max). */
  name: string;
  /** Description libre (255 caractères max). */
  description?: string;
  /** Quantité (>= 1). */
  quantity: number;
  /** Prix unitaire HT (>= 0). */
  unitPriceHt: number;
  /** Taux de TVA en % (ex. 20, 10, 5.5 ; >= 0). */
  vatRate: number;
  /** Remise sur la ligne (>= 0). */
  discount?: number;
  /** Référence article interne. */
  sku?: string;
  /** Code unité EN16931 (C62 = unité, KGM = kg, LTR = litre). */
  unitOfMeasure?: string;
  /** Code catégorie TVA EN16931 (S = standard, E = exonéré, Z = taux zéro). */
  taxCategoryCode?: string;
  /** Code article vendeur (EN16931). */
  itemIdentifier?: string;
  /** Code article acheteur (EN16931). */
  buyerItemIdentifier?: string;
}

/** Champs acceptés dans les DEUX modes. */
export interface ReceiptCommonFields {
  /**
   * E-mail du client final : rattachement à son compte ITICK, sinon salle
   * d'attente (+ QR si `generateQr`). Fournissez `customerEmail` OU
   * `customerPhone`, pas les deux (`400 INVALID_CHANNEL`).
   */
  customerEmail?: string;
  /** Téléphone du client final (voir `customerEmail`). */
  customerPhone?: string;
  /**
   * Votre identifiant unique de ticket/facture — LA clé d'idempotence
   * recommandée. Déduplication scopée à votre compte et à l'environnement :
   * un second envoi avec le même `externalId` renvoie `409
   * DUPLICATE_RECEIPT_DETECTED` avec `existingReceiptId`. Sa présence DÉSARME
   * le filet heuristique du serveur (« même commerçant, même montant, même
   * jour ») : deux ventes distinctes au même montant le même jour passent.
   * Fournissez-le toujours.
   */
  externalId?: string;
  /** Génère un QR de réclamation (utile si le client n'a pas de compte). */
  generateQr?: boolean;
  /** Identifiant opérateur / caissier (255 caractères max). */
  operatorId?: string;
}

/**
 * Mode STRUCTURÉ — détecté par la présence de `items`. Les six champs requis
 * le sont réellement côté serveur (`400 VALIDATION_ERROR` sinon). ITICK
 * calcule les totaux et la TVA depuis `items` : aucun total à déclarer.
 */
export interface StructuredReceipt extends ReceiptCommonFields {
  /** Date du reçu. REQUIS. */
  date: DateInput;
  /** SIRET du commerçant (14 chiffres). REQUIS. */
  merchantSiret: string;
  /** Nom du commerçant. REQUIS. */
  merchantName: string;
  /** E-mail du commerçant (matching / rattachement). REQUIS. */
  merchantEmail: string;
  /** Téléphone du commerçant. REQUIS. */
  merchantPhone: string;
  /** Lignes du reçu (au moins une). REQUIS. */
  items: ReceiptItem[];
  /**
   * Facultatif en mode structuré : document original (PDF/JPEG/PNG/WebP en
   * base64 strict, 10 Mo décodés max) joint au reçu — il n'est PAS lu.
   */
  documentPdf?: string;
  /** Moyen de paiement. */
  paymentMethod?: PaymentMethod;

  // --- Enrichissement commerçant (utilisé si le commerçant n'existe pas encore ou est incomplet) ---
  /** URL du logo du commerçant. */
  merchantLogo?: string;
  /** Numéro de TVA intracommunautaire du commerçant. */
  merchantVatNumber?: string;
  merchantAddress?: Address;
  /** Code NAF/APE du commerçant. */
  merchantNafCode?: string;
  /** Forme juridique du commerçant. */
  merchantLegalForm?: string;

  // --- EN16931 : acheteur / vendeur ---
  buyerName?: string;
  buyerSiret?: string;
  buyerVatNumber?: string;
  buyerAddress?: Address;
  sellerVatNumber?: string;
  sellerAddress?: Address;

  // --- EN16931 : dates, références, paiement ---
  deliveryDate?: DateInput;
  dueDate?: DateInput;
  /** IBAN du vendeur (EN16931). */
  paymentAccountIban?: string;
  /** BIC du vendeur (EN16931). */
  paymentAccountBic?: string;
  /** Référence de commande (EN16931). */
  purchaseOrderRef?: string;
  /** Référence de contrat (EN16931). */
  contractRef?: string;
  /** Code type de document EN16931 (380 = facture, 381 = avoir). */
  documentTypeCode?: string;
  /** Code catégorie fiscale EN16931 (S = standard, E = exonéré, Z = taux zéro). */
  taxCategoryCode?: string;
  /** Motif d'exonération de TVA. */
  taxExemptionReason?: string;
  /** Conditions de paiement (EN16931). */
  paymentTerms?: string;
}

/**
 * Mode DOCUMENT (« simple ») — `items` absent + `documentPdf` présent : ITICK
 * lit le document par OCR. Seul `documentPdf` est requis. Les autres champs
 * sont des indices facultatifs, prioritaires sur ce que l'OCR lit ; les champs
 * EN16931 du mode structuré ne sont PAS pris en compte ici.
 */
export interface DocumentReceipt extends ReceiptCommonFields {
  /** PDF / JPEG / PNG / WebP en base64 strict (10 Mo décodés max). REQUIS. */
  documentPdf: string;
  /** Interdit : la présence de `items` bascule en mode structuré. */
  items?: never;
  /** Indice OCR : nom du commerçant. */
  merchantName?: string;
  /** Indice OCR : date du reçu. */
  date?: DateInput;
  /**
   * Indice OCR : total TTC connu. Sert aussi de filet : si le document est
   * illisible (`422 DOCUMENT_UNREADABLE`), un brouillon minimal est quand même
   * créé à partir de ce montant (`receiptId` présent sur l'erreur).
   */
  totalTtc?: number;
}

/** Corps accepté par `pushReceipt` : structuré OU document. */
export type PushReceiptInput = StructuredReceipt | DocumentReceipt;

/** @deprecated Renommé `PushReceiptInput` (0.2.0). */
export type PushInput = PushReceiptInput;

// ---------------------------------------------------------------------------
// Types de réponse
// ---------------------------------------------------------------------------

export interface VatBreakdownLine {
  rate: number;
  baseHt: number;
  vatAmount: number;
}

export interface ReceiptTotals {
  totalHt: number;
  totalVat: number;
  totalTtc: number;
  currency: string;
  vatBreakdown?: VatBreakdownLine[];
}

/** Mode document : ce que l'OCR a lu (avant application de vos indices). */
export interface DocumentExtraction {
  merchantName?: string;
  /** ISO 8601. */
  date?: string;
  totalTtc?: number;
  confidence?: number;
}

/** Détail d'une `400 VALIDATION_ERROR` : chemin complet du champ fautif. */
export interface ValidationDetail {
  /** Ex. `merchantPhone`, `items[0].vatRate`, `buyerAddress.postalCode`. */
  field: string;
  errors: string[];
}

/** Réponse `201` de POST /receipts/providers. */
export interface PushResult {
  receiptId: string;
  invoiceNumber: string;
  /** true si rattaché à un utilisateur ITICK existant. */
  matched: boolean;
  /** Présent en mode document uniquement. */
  mode?: 'document';
  /** Mode structuré uniquement (calculés par ITICK depuis `items`). */
  totals?: ReceiptTotals;
  /** Mode document uniquement. */
  extraction?: DocumentExtraction | null;
  /** Mode structuré : catégorie suggérée par ITICK. */
  suggestedCategoryId?: string | null;
  /** Data-URL du QR (si `generateQr` / client non rattaché). */
  qrCode?: string | null;
  qrCodeUrl?: string | null;
  qrToken?: string | null;
}

/** Item de lot créé. */
export interface BatchItemCreated {
  index: number;
  status: 'created';
  receiptId: string;
  invoiceNumber: string;
  /** Posés uniquement sur les items en mode document. */
  mode?: 'document';
  matched?: boolean;
  extraction?: DocumentExtraction | null;
}

/**
 * Item de lot en erreur. Mêmes codes que la route unitaire
 * (`VALIDATION_ERROR` + `details`, `DUPLICATE_RECEIPT_DETECTED` +
 * `existingReceiptId`, `DOCUMENT_UNREADABLE`, `INTERNAL_ERROR`…). Un échec
 * n'interrompt PAS le lot : les autres items sont traités.
 */
export interface BatchItemError {
  index: number;
  status: 'error';
  /** Code stable. */
  error: string;
  message: string;
  /** `VALIDATION_ERROR` : champ par champ. */
  details?: ValidationDetail[];
  /** `DUPLICATE_RECEIPT_DETECTED`. */
  existingReceiptId?: string;
  /** `DOCUMENT_UNREADABLE` avec indice `totalTtc` : brouillon minimal créé. */
  receiptId?: string;
  matched?: boolean;
}

export type BatchItemResult = BatchItemCreated | BatchItemError;

/** Réponse de POST /receipts/providers/batch : `200` si tout est créé, `207` sinon. */
export interface BatchResult {
  /** Statut HTTP réel : 200 (tout créé) ou 207 (au moins un item en erreur). */
  httpStatus: 200 | 207;
  total: number;
  created: number;
  failed: number;
  /** Un résultat par reçu envoyé, dans l'ordre (`index`). */
  results: BatchItemResult[];
}

// ---------------------------------------------------------------------------
// Erreur typée
// ---------------------------------------------------------------------------

/** Corps d'erreur renvoyé par ITICK. */
export interface ItickErrorBody {
  error?: string;
  message?: string;
  details?: unknown;
  existingReceiptId?: string;
  receiptId?: string;
  /** Début du corps brut quand la réponse n'était pas du JSON (tronqué). */
  rawBody?: string;
}

/**
 * Levée quand ITICK renvoie un statut non-2xx (après épuisement des retries
 * pour les statuts transitoires). Le `code` est un identifiant stable :
 * `MODE_REQUIRED`, `VALIDATION_ERROR`, `INVALID_CHANNEL`,
 * `DUPLICATE_RECEIPT_DETECTED`, `DOCUMENT_UNREADABLE`,
 * `DOCUMENT_PDF_TOO_LARGE`, `UNSUPPORTED_DOCUMENT_FORMAT`,
 * `IDEMPOTENCY_KEY_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`…
 */
export class ItickIngestError extends Error {
  readonly status: number;
  readonly code: string;
  /** `VALIDATION_ERROR` : chemin complet du champ fautif + contraintes violées. */
  readonly details?: ValidationDetail[];
  /** Présent sur un doublon (409 `DUPLICATE_RECEIPT_DETECTED`). */
  readonly existingReceiptId?: string;
  /** Présent sur un document illisible (422) qui a quand même créé un brouillon. */
  readonly receiptId?: string;
  /**
   * Début du corps brut, tronqué, quand la réponse n'était pas du JSON (page
   * d'erreur d'un proxy, portail captif…). Jamais dans `message` : il finirait
   * en entier dans les logs de l'appelant.
   */
  readonly rawBody?: string;

  constructor(status: number, body: ItickErrorBody) {
    super(truncate(body.message, MAX_ERROR_MESSAGE_CHARS) || body.error || `ITICK ingest error (HTTP ${status})`);
    this.name = 'ItickIngestError';
    this.status = status;
    this.code = body.error || 'UNKNOWN';
    if (Array.isArray(body.details)) this.details = body.details as ValidationDetail[];
    if (body.existingReceiptId !== undefined) this.existingReceiptId = body.existingReceiptId;
    if (body.receiptId !== undefined) this.receiptId = body.receiptId;
    if (body.rawBody !== undefined) this.rawBody = body.rawBody;
  }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ItickClientOptions {
  /**
   * Clé API (sandbox `itick_sandbox_…` ou production `itick_…`). Les espaces
   * de début/fin sont retirés (clé lue depuis un fichier) ; tout autre
   * caractère non transmissible dans un en-tête HTTP est refusé — sans jamais
   * recopier la valeur dans le message d'erreur.
   */
  apiKey: string;
  /**
   * Base URL. Défaut : https://api.itick.fr/itick. **`https` obligatoire** :
   * sinon la clé API circulerait en clair. Seul `http://localhost` (ou
   * `127.0.0.1` / `::1`) est toléré, pour le développement.
   */
  baseUrl?: string;
  /** Implémentation fetch (défaut : fetch global). Utile pour les tests. */
  fetch?: typeof fetch;
  /** Timeout par tentative en ms — en-têtes ET corps. Entier > 0, défaut 30000. */
  timeoutMs?: number;
  /**
   * Nombre de NOUVELLES tentatives après un échec transitoire — erreur
   * réseau, timeout, `5xx`, `429`, ou `409 IDEMPOTENCY_KEY_IN_PROGRESS`.
   * Défaut : 3 (attentes 500 ms, 2 s, 5 s + jitter). Entier de 0 à 10 ; `0`
   * désactive le retry. Jamais de retry sur un autre `4xx`.
   * Toutes les tentatives d'un même appel portent la MÊME `Idempotency-Key` :
   * le serveur rejoue la réponse déjà produite au lieu de créer un doublon.
   */
  retries?: number;
}

export interface PushOptions {
  /**
   * Clé d'idempotence envoyée dans l'en-tête `Idempotency-Key` (256 caractères
   * max). Le serveur rejoue la réponse à l'identique pendant 24 h pour la même
   * clé (même corps). Si vous n'en fournissez pas, le SDK en génère une (UUID)
   * pour l'appel — elle couvre les retries du SDK, pas ceux de votre propre
   * process : pour ces derniers, fournissez votre clé, et `externalId`.
   */
  idempotencyKey?: string;
}

const DEFAULT_BASE_URL = 'https://api.itick.fr/itick';
const DEFAULT_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Borne haute de `retries` : au-delà, la boucle dure des jours pour rien. */
const MAX_RETRIES = 10;
/** Ce que le SDK affiche à la place de la clé API (jamais la clé). */
const REDACTED = '[redacted]';
/** Plafond de l'attente demandée par un `Retry-After` (un serveur fâché ne nous gare pas des heures). */
const MAX_RETRY_AFTER_MS = 30_000;
/** Jitter appliqué au backoff (±20 %) pour désynchroniser les partenaires. */
const RETRY_JITTER_RATIO = 0.2;
/** Taille maximale du corps de réponse lu (au-delà : erreur, jamais de mise en mémoire). */
const MAX_RESPONSE_BYTES = 1_000_000;
/** Longueur maximale d'un message d'erreur relayé à l'appelant. */
const MAX_ERROR_MESSAGE_CHARS = 512;
/** Longueur maximale de l'extrait de corps brut conservé sur `rawBody`. */
const MAX_RAW_BODY_CHARS = 256;
/** Caractères transmissibles dans une valeur d'en-tête HTTP : ASCII imprimable sans espace. */
const HEADER_TOKEN_RE = /^[\x21-\x7e]+$/;
/** Hôtes pour lesquels `http://` est toléré (développement local). */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
/** Attente avant la 1re, 2e, 3e… nouvelle tentative (la dernière valeur se répète). */
export const RETRY_BACKOFF_MS: readonly number[] = [500, 2_000, 5_000];

/**
 * Valide la clé API. Le message d'erreur ne reproduit JAMAIS la valeur, même
 * partiellement : il finirait dans les logs (et les agrégateurs) de l'appelant.
 */
function normalizeApiKey(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('ItickClient: apiKey requis.');
  const apiKey = raw.trim();
  if (!HEADER_TOKEN_RE.test(apiKey)) {
    throw new Error(
      'ItickClient: apiKey invalide — elle contient des caractères impossibles à transmettre ' +
        "dans un en-tête HTTP (retour à la ligne, tabulation, espace interne…). La valeur n'est " +
        'volontairement pas reproduite ici.',
    );
  }
  return apiKey;
}

/** Exige une URL absolue en `https` (la clé API voyage dedans). */
function normalizeBaseUrl(raw: string | undefined): string {
  const value = raw && raw.trim() !== '' ? raw.trim() : DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ItickClient: baseUrl n'est pas une URL absolue valide (« ${value} »).`);
  }
  const local = LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(
      `ItickClient: baseUrl doit être en https (reçu « ${url.protocol}//${url.host} ») — sinon la ` +
        'clé API circulerait en clair sur le réseau. Seul http://localhost (127.0.0.1, ::1) est ' +
        'toléré pour le développement.',
    );
  }
  return value.replace(/\/$/, '');
}

export class ItickClient {
  /** Champ privé ECMAScript : invisible de `Object.keys`, `JSON.stringify`, du spread. */
  readonly #apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;

  constructor(options: ItickClientOptions) {
    this.#apiKey = normalizeApiKey(options.apiKey);
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error('ItickClient: aucun fetch disponible (Node >= 18 requis, ou passez options.fetch).');
    this.fetchImpl = f;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error('ItickClient: timeoutMs doit être un entier > 0 (millisecondes).');
    }
    this.timeoutMs = timeoutMs;
    const retries = options.retries ?? DEFAULT_RETRIES;
    if (!Number.isInteger(retries) || retries < 0 || retries > MAX_RETRIES) {
      throw new Error(`ItickClient: retries doit être un entier entre 0 et ${MAX_RETRIES}.`);
    }
    this.retries = retries;
  }

  /**
   * Représentation sûre du client : la clé API n'y figure jamais. Couvre
   * `JSON.stringify(client)` et tout rapporteur d'erreurs qui sérialise son
   * contexte (Sentry, Datadog…).
   */
  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, timeoutMs: this.timeoutMs, retries: this.retries, apiKey: REDACTED };
  }

  /** Même redaction pour `console.log(client)` / `util.inspect(client)`. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `ItickClient ${JSON.stringify(this.toJSON())}`;
  }

  /** Pousse un reçu (mode structuré ou document, détecté par ITICK d'après les champs). */
  async pushReceipt(input: PushReceiptInput, opts: PushOptions = {}): Promise<PushResult> {
    const { body } = await this.post<PushResult>('/receipts/providers', input, opts, 'receiptId');
    return body;
  }

  /**
   * Pousse un lot (1 à 100 reçus, structurés et/ou documents). Ne rejette
   * JAMAIS pour un item en erreur : lisez `results[i].status`. Rejette
   * (`ItickIngestError`) uniquement si l'enveloppe est refusée (400) ou sur
   * une erreur transitoire après épuisement des retries.
   */
  async pushBatch(receipts: PushReceiptInput[], opts: PushOptions = {}): Promise<BatchResult> {
    if (receipts.length === 0) throw new Error('pushBatch: au moins un reçu requis.');
    if (receipts.length > 100) throw new Error('pushBatch: 100 reçus maximum par lot.');
    const { status, body } = await this.post<Omit<BatchResult, 'httpStatus'>>(
      '/receipts/providers/batch',
      { receipts },
      opts,
      'results',
    );
    return { ...body, httpStatus: status === 207 ? 207 : 200 };
  }

  /**
   * Confort : pousse un document depuis des octets bruts (Buffer / Uint8Array),
   * en l'encodant en base64 pour vous.
   */
  async pushDocument(
    bytes: Uint8Array,
    meta: Omit<DocumentReceipt, 'documentPdf'> = {},
    opts: PushOptions = {},
  ): Promise<PushResult> {
    const documentPdf = Buffer.from(bytes).toString('base64');
    return this.pushReceipt({ ...meta, documentPdf }, opts);
  }

  // -- interne ------------------------------------------------------------

  /**
   * POST avec retry borné. Une seule `Idempotency-Key` par appel, réutilisée
   * sur chaque tentative : c'est elle qui rend le retry sans doublon.
   */
  private async post<T>(
    path: string,
    body: unknown,
    opts: PushOptions,
    pivot: 'receiptId' | 'results',
  ): Promise<{ status: number; body: T }> {
    const idempotencyKey = normalizeIdempotencyKey(opts.idempotencyKey);
    const payload = JSON.stringify(body);

    for (let attempt = 0; ; attempt++) {
      let attemptResult: FetchOutcome;
      try {
        attemptResult = await this.fetchOnce(path, payload, idempotencyKey);
      } catch (err) {
        // Erreur réseau ou timeout : on ne sait pas si le serveur a traité la
        // requête — la même Idempotency-Key garantit qu'il ne la traitera pas
        // deux fois. Une erreur DÉFINITIVE (bug de programmation, redirection
        // refusée, réponse hors contrat) est relancée tout de suite : la
        // rejouer ne fait que perdre du temps et masquer la cause.
        if (isRetryableException(err) && attempt < this.retries) {
          await sleep(backoffMs(attempt, null));
          continue;
        }
        throw err;
      }

      const { status, text, retryAfterMs } = attemptResult;
      const parsed: unknown = text.trim() !== '' ? safeJson(text) : {};
      if (status >= 200 && status < 300) return { status, body: assertContract<T>(status, parsed, pivot) };

      if (isTransientResponse(status, errorCodeOf(parsed)) && attempt < this.retries) {
        await sleep(backoffMs(attempt, retryAfterMs));
        continue;
      }
      throw new ItickIngestError(status, (isRecord(parsed) ? parsed : {}) as ItickErrorBody);
    }
  }

  /**
   * Une tentative : en-têtes ET corps sont lus sous le MÊME timeout (un
   * serveur qui envoie les en-têtes puis se tait bloquait l'appelant sans
   * limite), et le corps est borné en taille.
   */
  private async fetchOnce(path: string, payload: string, idempotencyKey: string): Promise<FetchOutcome> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
          'User-Agent': `@itick/ingest/${SDK_VERSION}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: payload,
        signal: controller.signal,
        // L'API ITICK ne redirige pas : toute redirection est anormale et doit
        // échouer bruyamment plutôt que d'expédier le reçu (e-mail client,
        // SIRET, montants) vers un autre hôte.
        redirect: 'error',
      });
      return {
        status: res.status,
        text: await readBoundedText(res),
        retryAfterMs: parseRetryAfterMs(res.headers.get('retry-after')),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Ce qu'une tentative rapporte : statut, corps borné, attente demandée. */
interface FetchOutcome {
  status: number;
  text: string;
  retryAfterMs: number | null;
}

/**
 * Valide la clé d'idempotence fournie par l'appelant (256 caractères max,
 * caractères d'en-tête HTTP) avant qu'elle ne fasse échouer `fetch` au milieu
 * de la boucle de retry. À défaut, le SDK en génère une pour l'appel.
 */
function normalizeIdempotencyKey(raw: string | undefined): string {
  if (raw === undefined) return randomUUID();
  const key = raw.trim();
  if (key === '' || key.length > 256 || !HEADER_TOKEN_RE.test(key)) {
    throw new Error(
      'ItickClient: idempotencyKey invalide (1 à 256 caractères ASCII imprimables, sans espace).',
    );
  }
  return key;
}

/**
 * Transitoire = `5xx`, `429`, ou le `409 IDEMPOTENCY_KEY_IN_PROGRESS` : ce
 * dernier est exactement l'état que le retry du SDK provoque quand la première
 * tentative a dépassé le timeout pendant que le serveur travaillait encore.
 * Le rejouer AVEC LA MÊME clé rend la réponse déjà produite, jamais un
 * doublon. Tout autre `4xx` est définitif : on ne rejoue pas.
 */
function isTransientResponse(status: number, code: string | undefined): boolean {
  if (status === 429 || status >= 500) return true;
  return status === 409 && code === 'IDEMPOTENCY_KEY_IN_PROGRESS';
}

/**
 * Une exception de `fetch` n'est pas forcément transitoire : une erreur de
 * programmation, une URL invalide ou une redirection refusée seraient rejouées
 * pour rien (7,5 s perdues) et la cause finirait masquée.
 */
function isRetryableException(err: unknown): boolean {
  if (err instanceof ItickIngestError) return false;
  if (!(err instanceof Error)) return false;
  // Notre propre timeout (AbortController) : la tentative suivante est légitime.
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return true;
  if (!(err instanceof TypeError)) return false;
  const cause = (err as { cause?: unknown }).cause;
  const causeMessage = cause instanceof Error ? cause.message : '';
  const causeCode = isRecord(cause) && typeof cause['code'] === 'string' ? cause['code'] : '';
  // `redirect: 'error'` remonte aussi un « fetch failed » : c'est définitif.
  if (/redirect/i.test(causeMessage)) return false;
  if (TRANSIENT_NETWORK_CODES.has(causeCode)) return true;
  return /fetch failed|network|socket|terminated|other side closed/i.test(err.message);
}

/** Codes système d'une coupure réseau passagère. */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * Attente avant la prochaine tentative. `Retry-After` du serveur prime (borné),
 * sinon le backoff par défaut — le tout avec un jitter de ±20 % : sans lui,
 * tous les partenaires réessaient à la même seconde après un incident.
 */
function backoffMs(attempt: number, retryAfterMs: number | null): number {
  const base = RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)] ?? 0;
  const wait = retryAfterMs !== null ? retryAfterMs : base;
  const jitter = wait * RETRY_JITTER_RATIO * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(wait + jitter));
}

/** `Retry-After` : nombre de secondes ou date HTTP. Borné, et jamais négatif. */
function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const raw = header.trim();
  if (raw === '') return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return clampRetryAfter(seconds * 1000);
  const date = Date.parse(raw);
  if (!Number.isNaN(date)) return clampRetryAfter(date - Date.now());
  return null;
}

function clampRetryAfter(ms: number): number {
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Lit le corps sous le timeout de la tentative, en le bornant : une page
 * d'erreur d'infrastructure ou un flux sans fin ne doivent pas être
 * intégralement mis en mémoire.
 */
async function readBoundedText(res: Response): Promise<string> {
  const body = res.body;
  // Pas de flux exploitable (204, mock de test) : rien à borner en streaming.
  if (!body || typeof body.getReader !== 'function') return await res.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new ItickIngestError(res.status, {
          error: 'RESPONSE_TOO_LARGE',
          message: `réponse ITICK tronquée : plus de ${MAX_RESPONSE_BYTES} octets.`,
        });
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * Un `2xx` ne suffit pas à dire « reçu créé » : un proxy d'entreprise ou un
 * portail captif répond `200` + HTML. On exige la présence du champ pivot du
 * contrat, sinon on lève au lieu de rendre un `receiptId` `undefined`.
 */
function assertContract<T>(status: number, parsed: unknown, pivot: 'receiptId' | 'results'): T {
  const ok =
    isRecord(parsed) &&
    (pivot === 'results' ? Array.isArray(parsed['results']) : typeof parsed['receiptId'] === 'string');
  if (!ok) {
    throw new ItickIngestError(status, {
      error: 'INVALID_RESPONSE',
      message:
        `réponse HTTP ${status} non conforme au contrat ITICK : champ « ${pivot} » absent ou ` +
        "de type inattendu. Le reçu n'est PAS confirmé (proxy, portail captif, mauvaise baseUrl ?).",
      ...(isRecord(parsed) && typeof parsed['rawBody'] === 'string' ? { rawBody: parsed['rawBody'] } : {}),
    });
  }
  return parsed as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCodeOf(parsed: unknown): string | undefined {
  return isRecord(parsed) && typeof parsed['error'] === 'string' ? parsed['error'] : undefined;
}

function truncate(text: string | undefined, max: number): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}… (tronqué, ${text.length} caractères)`;
}

/**
 * Corps non-JSON : on ne le promeut PAS en message d'erreur — une page HTML
 * d'infrastructure (version du serveur, adresse d'upstream) finirait entière
 * dans les logs de l'intégrateur. On en garde un extrait borné sur `rawBody`.
 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {
      error: 'NON_JSON_RESPONSE',
      message: `réponse non-JSON (${text.length} caractères).`,
      rawBody: truncate(text, MAX_RAW_BODY_CHARS),
    };
  }
}
