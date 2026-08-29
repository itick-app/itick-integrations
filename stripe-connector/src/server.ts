/**
 * Serveur du connecteur Stripe → ITICK.
 *
 * Un commerçant qui facture via Stripe branche ce service sur ses webhooks Stripe.
 * À chaque facture payée, la facture est mappée puis poussée vers ITICK, qui la
 * certifie et la route au client final (matching par email).
 *
 * `node:http` brut (zéro dépendance serveur) — et surtout : lecture du corps BRUT,
 * indispensable pour vérifier la signature Stripe (un framework qui re-parse le
 * JSON casserait la signature — piège n°1 des intégrations webhook).
 */
import http from 'node:http';
import { ItickClient, ItickIngestError } from '@itick/ingest';
import type { MapOptions, StripeInvoiceLike } from './mapInvoice.js';
import { StripeMappingError, mapStripeInvoiceToItick } from './mapInvoice.js';
import { StripeSignatureError, verifyStripeSignature } from './verifyStripeSignature.js';

export interface ConnectorConfig {
  /** Clé API ITICK (sandbox `itick_sandbox_…` ou prod `itick_…`). */
  itickApiKey: string;
  /** Secret de signature du webhook Stripe (`whsec_…`). */
  stripeWebhookSecret: string;
  /** Base URL ITICK (défaut : SDK → https://api.itick.fr/itick). */
  itickBaseUrl?: string;
  /** Chemin d'écoute du webhook (défaut `/webhooks/stripe`). */
  webhookPath?: string;
  /** Événements Stripe traités (défaut `['invoice.paid']`). */
  events?: string[];
  /** Options de mapping : SIRET, e-mail et téléphone émetteur sont requis (contrat ITICK). */
  mapOptions: MapOptions;
  /** Injections pour les tests. */
  now?: () => number;
}

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

interface Deps {
  client?: ItickClient;
  logger?: Logger;
}

const DEFAULT_EVENTS = ['invoice.paid'];

/** Taille maximale d'un webhook Stripe accepté (les événements réels sont bien en deçà). */
const MAX_BODY_BYTES = 1_000_000;

/** Délai laissé à un émetteur trop bavard pour finir d'envoyer après le 413. */
const DRAIN_TIMEOUT_MS = 5_000;

/** Dépassement de la limite de taille : doit produire un 413, pas une coupure. */
class PayloadTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Corps trop volumineux (limite ${limitBytes} octets).`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Lecture du corps BRUT, bornée. Au-delà de la limite on ne détruit PAS la
 * socket : l'appelant doit d'abord pouvoir répondre 413 — sinon Stripe voit
 * une connexion coupée, la prend pour un incident passager et rejoue
 * indéfiniment un corps qui sera toujours trop gros. Le reste du flux est
 * consommé et JETÉ au fil de l'eau : la mémoire reste bornée.
 */
function readRawBody(req: http.IncomingMessage, limitBytes = MAX_BODY_BYTES): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let overflowed = false;
    req.on('data', (chunk: Buffer) => {
      if (overflowed) return; // au-delà de la limite : on jette, on ne stocke plus
      size += chunk.length;
      if (size > limitBytes) {
        overflowed = true;
        chunks = [];
        reject(new PayloadTooLargeError(limitBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

/**
 * Construit le serveur HTTP du connecteur. Ne démarre PAS l'écoute (voir `index.ts`),
 * ce qui le rend testable (on peut injecter un `ItickClient` factice).
 */
export function createConnectorServer(config: ConnectorConfig, deps: Deps = {}): http.Server {
  const logger = deps.logger ?? console;
  const client =
    deps.client ??
    new ItickClient({
      apiKey: config.itickApiKey,
      ...(config.itickBaseUrl ? { baseUrl: config.itickBaseUrl } : {}),
      // Pas de retry côté SDK : un webhook doit répondre vite, et c'est Stripe
      // qui rejoue sur notre 500 (voir README « Réponses & retries »).
      retries: 0,
    });
  const webhookPath = config.webhookPath ?? '/webhooks/stripe';
  const events = new Set(config.events ?? DEFAULT_EVENTS);
  // Une clé `itick_sandbox_…` n'accepte que des événements Stripe de test ;
  // toute autre clé (production) n'accepte que du livemode.
  const expectedLivemode = !config.itickApiKey.startsWith('itick_sandbox_');

  return http.createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error('[stripe-connector] erreur inattendue :', err);
      if (!res.headersSent) send(res, 500, { error: 'INTERNAL_ERROR' });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Healthcheck (utile pour Docker / load-balancer).
    if (req.method === 'GET' && req.url === '/health') {
      send(res, 200, { status: 'ok' });
      return;
    }
    if (req.method !== 'POST' || req.url !== webhookPath) {
      send(res, 404, { error: 'NOT_FOUND' });
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch (err) {
      if (!(err instanceof PayloadTooLargeError)) throw err;
      logger.warn('[stripe-connector] requête refusée :', err.message);
      // Stripe doit voir un 413 (refus définitif), pas une socket fermée en
      // plein envoi — qu'il prendrait pour un incident et rejouerait. On laisse
      // donc l'émetteur finir d'envoyer (flux jeté), avec une échéance ferme.
      const drainDeadline = setTimeout(() => req.destroy(), DRAIN_TIMEOUT_MS);
      drainDeadline.unref();
      req.on('end', () => clearTimeout(drainDeadline));
      send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      return;
    }

    // 1. Vérifier la signature sur le corps BRUT.
    let event: { type?: string; id?: string; livemode?: unknown; data?: { object?: unknown } };
    try {
      event = verifyStripeSignature(
        raw,
        req.headers['stripe-signature'] as string | undefined,
        config.stripeWebhookSecret,
        config.now ? { nowSeconds: config.now() } : {},
      ) as typeof event;
    } catch (err) {
      // Le détail reste dans le LOG de l'opérateur. Le renvoyer à l'appelant —
      // non authentifié à ce stade — en ferait un oracle de configuration
      // (« secret configuré ? », tolérance d'horloge, décalage d'horloge).
      const message = err instanceof StripeSignatureError ? err.message : 'Signature refusée.';
      logger.warn('[stripe-connector] signature refusée :', message);
      send(res, 400, { error: 'INVALID_SIGNATURE' });
      return;
    }

    // 2. Filtrer les événements. Tout ack en 200 pour éviter les retries Stripe.
    if (!event.type || !events.has(event.type)) {
      send(res, 200, { received: true, ignored: event.type ?? null });
      return;
    }

    // 2 bis. Le mode de l'événement doit correspondre à celui de la clé ITICK.
    // Sans ce contrôle, un `stripe trigger invoice.paid` (livemode=false) lancé
    // pendant que la clé de PRODUCTION est configurée fait certifier une
    // facture de test sous le vrai SIRET, et la route au client final.
    if (event.livemode !== expectedLivemode) {
      logger.error(
        `[stripe-connector] événement ${event.id} REFUSÉ : livemode=${String(event.livemode)} alors que ` +
          `la clé ITICK est ${expectedLivemode ? 'de PRODUCTION' : 'de SANDBOX'}. ` +
          'Le secret de webhook Stripe et la clé ITICK ne sont pas du même monde — corrigez la configuration.',
      );
      send(res, 200, { received: true, rejected: 'LIVEMODE_MISMATCH' });
      return;
    }

    const invoice = event.data?.object as StripeInvoiceLike | undefined;
    if (!invoice || typeof invoice.id !== 'string') {
      logger.warn('[stripe-connector] événement sans facture exploitable :', event.id);
      send(res, 200, { received: true, ignored: 'no-invoice' });
      return;
    }

    // 3. Mapper puis pousser vers ITICK (idempotence = l'ID de l'événement Stripe).
    // Une facture que le mapping ne sait pas représenter fidèlement (devise
    // étrangère, ligne négative, TVA inconnue) est REFUSÉE ici, avec son motif :
    // mieux vaut une facture non certifiée et journalisée qu'un document
    // certifié faux. Rejouer n'y changerait rien → ack 200.
    let receipt;
    try {
      receipt = mapStripeInvoiceToItick(invoice, config.mapOptions);
    } catch (err) {
      if (!(err instanceof StripeMappingError)) throw err;
      logger.error(
        `[stripe-connector] facture ${invoice.id} NON CERTIFIÉE (${err.code}) : ${err.message} ` +
          '→ aucun reçu ITICK créé, traitement manuel requis.',
      );
      send(res, 200, { received: true, rejected: err.code, message: err.message });
      return;
    }

    try {
      const result = await client.pushReceipt(receipt, {
        idempotencyKey: `stripe-evt-${event.id}`,
      });
      logger.log(
        `[stripe-connector] facture ${invoice.id} → reçu ITICK ${result.receiptId} (matched=${result.matched}).`,
      );
      send(res, 200, { received: true, receiptId: result.receiptId, matched: result.matched });
      return;
    } catch (err) {
      if (err instanceof ItickIngestError) {
        // Doublon = déjà reçu (retry Stripe) → succès idempotent.
        if (err.status === 409) {
          logger.log(`[stripe-connector] facture ${invoice.id} déjà reçue (doublon ignoré).`);
          send(res, 200, { received: true, duplicate: true, receiptId: err.existingReceiptId });
          return;
        }
        // Erreur 4xx = permanente (payload invalide) : ack 200 + log, inutile de faire
        // retenter Stripe pendant des jours. L'opérateur voit le log.
        if (err.status >= 400 && err.status < 500) {
          logger.error(
            `[stripe-connector] facture ${invoice.id} rejetée par ITICK (${err.code}) : ${err.message}. Non rejouable — vérifiez le mapping.`,
          );
          send(res, 200, { received: true, rejected: err.code });
          return;
        }
      }
      // Réseau / 5xx ITICK = transitoire → 500, Stripe rejouera automatiquement.
      logger.error(`[stripe-connector] échec transitoire sur ${invoice.id} :`, err);
      send(res, 500, { error: 'ITICK_PUSH_FAILED' });
      return;
    }
  }
}
