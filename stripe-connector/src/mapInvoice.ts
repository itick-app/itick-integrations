/**
 * Mapping facture Stripe → reçu ITICK (mode structuré).
 *
 * Cas d'usage : un commerçant qui facture via Stripe transfère automatiquement
 * ses factures émises à ITICK, qui les route au bon client final (matching par
 * `customerEmail`). Fonction PURE → testable sans réseau ni Stripe.
 *
 * ⚠️ RÈGLE DE CONDUITE DE CE CONNECTEUR (2026-08-29) — le document produit par
 * ITICK est certifié (Factur-X, RFC3161, PAF) donc scellé : il vaut mieux
 * REFUSER une facture qu'on ne sait pas représenter fidèlement que la
 * certifier faussement. Chaque refus lève une `StripeMappingError` portant un
 * code stable et un motif lisible ; le serveur le journalise. Aucune valeur
 * n'est inventée — en particulier aucun taux de TVA.
 *
 * Hypothèses restantes, assumées et documentées dans le README :
 *  - Montants en CENTIMES d'euro (les autres devises sont refusées).
 *  - Taxe EXCLUSIVE (config Stripe par défaut) : `line.amount` = HT. Si votre
 *    compte est en taxe INCLUSIVE, adaptez ce fichier (voir README).
 */

// On réutilise les types du SDK officiel : le mapping produit exactement ce que
// `client.pushReceipt(...)` attend, garanti par le compilateur.
import type { ReceiptItem, StructuredReceipt } from '@itick/ingest';

// Sous-ensemble typé des champs Stripe utilisés (évite d'imposer la version exacte du SDK Stripe).
export interface StripeInvoiceLike {
  id: string;
  created: number; // unix seconds
  currency: string;
  customer_email: string | null;
  customer_name?: string | null;
  account_name?: string | null;
  lines: {
    data: Array<{
      description: string | null;
      quantity: number | null;
      amount: number; // centimes, HT (taxe exclusive)
      tax_rates?: Array<{ percentage?: number | null }> | null;
    }>;
  };
}

export interface MapOptions {
  /** Nom du commerçant (le vôtre). Défaut : account_name de la facture. */
  merchantName?: string;
  /** Votre SIRET (14 chiffres) — REQUIS par ITICK en mode structuré. */
  merchantSiret: string;
  /** Votre e-mail émetteur — REQUIS par ITICK en mode structuré. */
  merchantEmail: string;
  /** Votre téléphone — REQUIS par ITICK en mode structuré. */
  merchantPhone: string;
  /**
   * Taux de TVA (%) à appliquer aux lignes SANS taux Stripe. **Aucun défaut :**
   * non renseigné, une telle ligne fait REFUSER la facture
   * (`VAT_RATE_UNKNOWN`) au lieu de fabriquer 20 %. En franchise en base de
   * TVA, posez explicitement `0`.
   */
  defaultVatRate?: number;
}

/** Motifs de refus. Codes stables : ils sont journalisés et renvoyés à Stripe. */
export type StripeMappingErrorCode =
  | 'UNSUPPORTED_CURRENCY'
  | 'NEGATIVE_LINE'
  | 'VAT_RATE_UNKNOWN'
  | 'MULTIPLE_TAX_RATES';

/**
 * Levée quand la facture Stripe ne peut pas être représentée fidèlement dans
 * le contrat d'ingestion ITICK. Un refus explicite et journalisé vaut mieux
 * qu'un document certifié faux.
 */
export class StripeMappingError extends Error {
  readonly code: StripeMappingErrorCode;

  constructor(code: StripeMappingErrorCode, message: string) {
    super(message);
    this.name = 'StripeMappingError';
    this.code = code;
  }
}

/** Seule devise représentable : le contrat d'ingestion ITICK ne porte pas de devise. */
const SUPPORTED_CURRENCY = 'eur';
/** Longueur maximale d'un libellé de ligne côté ITICK. */
const MAX_NAME_LENGTH = 255;

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clampName = (name: string): string =>
  name.length <= MAX_NAME_LENGTH ? name : `${name.slice(0, MAX_NAME_LENGTH - 1)}…`;

export function mapStripeInvoiceToItick(
  invoice: StripeInvoiceLike,
  opts: MapOptions,
): StructuredReceipt {
  assertSupportedCurrency(invoice);
  assertUsableDefaultVatRate(opts.defaultVatRate);

  const items: ReceiptItem[] = invoice.lines.data.map((line, index) => mapLine(line, index, opts));

  const merchantName =
    opts.merchantName ?? invoice.account_name ?? 'Commerçant';

  return {
    date: new Date(invoice.created * 1000).toISOString(),
    // Les 5 champs commerçant + items sont REQUIS par ITICK en mode structuré
    // (400 VALIDATION_ERROR sinon) — le type StructuredReceipt l'impose.
    merchantSiret: opts.merchantSiret,
    merchantName,
    merchantEmail: opts.merchantEmail,
    merchantPhone: opts.merchantPhone,
    ...(invoice.customer_email ? { customerEmail: invoice.customer_email } : {}),
    items,
    // Déduplication : ITICK ignore un re-push du même externalId (retry Stripe).
    externalId: `stripe-invoice-${invoice.id}`,
  };
}

/**
 * La devise Stripe était lue puis jetée : une facture en USD était certifiée
 * comme si c'étaient des euros, et `/100` est faux pour les devises à 0
 * décimale (JPY, KRW → ×100 d'écart) ou à 3 (KWD, TND → ×10). Le contrat
 * d'ingestion ITICK ne porte AUCUN champ devise : on ne peut pas la
 * transmettre, donc on refuse.
 */
function assertSupportedCurrency(invoice: StripeInvoiceLike): void {
  const currency = (invoice.currency ?? '').toLowerCase();
  if (currency === SUPPORTED_CURRENCY) return;
  throw new StripeMappingError(
    'UNSUPPORTED_CURRENCY',
    `devise « ${invoice.currency} » non représentable : le contrat d'ingestion ITICK ne porte pas ` +
      "de devise (les montants sont lus en euros) et l'exposant Stripe varie selon la devise. " +
      'Certifier cette facture produirait un montant et une devise faux.',
  );
}

function assertUsableDefaultVatRate(rate: number | undefined): void {
  if (rate === undefined) return;
  if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
    throw new StripeMappingError(
      'VAT_RATE_UNKNOWN',
      `defaultVatRate invalide (${rate}) : attendu un pourcentage entre 0 et 100.`,
    );
  }
}

function mapLine(
  line: StripeInvoiceLike['lines']['data'][number],
  index: number,
  opts: MapOptions,
): ReceiptItem {
  const label = `ligne ${index + 1}`;

  // Prorata d'abonnement, avoir : ITICK exige `unitPriceHt >= 0` en mode
  // structuré. Envoyer la facture ferait échouer TOUTE la requête (400), et
  // ce rejet était ensuite acquitté en 200 à Stripe : la facture disparaissait
  // en silence. On refuse ici, avec le motif.
  if (line.amount < 0) {
    throw new StripeMappingError(
      'NEGATIVE_LINE',
      `${label} : montant négatif (${line.amount} centimes) — prorata d'abonnement ou avoir. ` +
        'Le mode structuré ITICK exige un prix unitaire positif ; un avoir est un document ' +
        'distinct (EN16931 381). Facture à traiter à la main.',
    );
  }

  const rawQuantity = line.quantity && line.quantity > 0 ? Math.trunc(line.quantity) : 1;
  const quantity = rawQuantity > 0 ? rawQuantity : 1;
  const vatRate = resolveVatRate(line, opts, label);
  const name = line.description ?? 'Article';

  // ITICK RECALCULE le total depuis `quantity × unitPriceHt` : arrondir le prix
  // unitaire avant de multiplier faisait diverger le total certifié du montant
  // réellement encaissé (100,03 € pour 100,00 € encaissés sur 10000c/7), et
  // annulait même la ligne quand le prix unitaire tombait sous 0,5 centime.
  // Quand le total ne se divise pas au centime près, on regroupe la ligne :
  // quantité 1 au montant EXACT, quantité d'origine reportée dans le libellé.
  if (line.amount % quantity !== 0) {
    return {
      name: clampName(`${name} (× ${quantity})`),
      description: clampName(
        `Quantité Stripe : ${quantity}. Ligne regroupée : ${line.amount} centimes ne se divisent ` +
          'pas exactement, un prix unitaire arrondi fausserait le total certifié.',
      ),
      quantity: 1,
      unitPriceHt: round2(line.amount / 100),
      vatRate,
    };
  }

  return {
    name: clampName(name),
    quantity,
    unitPriceHt: round2(line.amount / quantity / 100),
    vatRate,
  };
}

/**
 * Le taux venait de `tax_rates[0].percentage`, sinon 20 % étaient FABRIQUÉS —
 * y compris pour un commerçant en franchise en base, qui se retrouvait avec un
 * document certifié portant une TVA qu'il n'a jamais collectée. Le connecteur
 * n'invente plus : sans taux Stripe et sans `defaultVatRate` explicite, il
 * refuse la facture.
 */
function resolveVatRate(
  line: StripeInvoiceLike['lines']['data'][number],
  opts: MapOptions,
  label: string,
): number {
  const rates = line.tax_rates ?? [];
  if (rates.length > 1) {
    throw new StripeMappingError(
      'MULTIPLE_TAX_RATES',
      `${label} : ${rates.length} taux de TVA sur une même ligne Stripe — une ligne ITICK n'en ` +
        "porte qu'un. N'en retenir qu'un fausserait la TVA du document.",
    );
  }

  const percentage = rates[0]?.percentage;
  if (typeof percentage === 'number' && Number.isFinite(percentage) && percentage >= 0) {
    return percentage;
  }

  if (opts.defaultVatRate === undefined) {
    throw new StripeMappingError(
      'VAT_RATE_UNKNOWN',
      `${label} : aucun taux de TVA exploitable côté Stripe (\`tax_rates\` absent, vide, ou sans ` +
        'pourcentage) et DEFAULT_VAT_RATE n\'est pas configuré. Le connecteur n\'invente pas de ' +
        'taux : renseignez DEFAULT_VAT_RATE (0 si vous êtes en franchise en base de TVA).',
    );
  }
  return opts.defaultVatRate;
}
