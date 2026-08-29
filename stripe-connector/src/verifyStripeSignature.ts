/**
 * Vérification de la signature d'un webhook Stripe (en-tête `Stripe-Signature`).
 *
 * Stripe signe chaque livraison ainsi :  `t=<timestamp>,v1=<hmac>`
 * où `hmac = HMAC_SHA256(secret, "<timestamp>.<raw_body>")`.
 * (https://stripe.com/docs/webhooks/signatures)
 *
 * On reproduit `stripe.webhooks.constructEvent` sans dépendre du SDK Stripe :
 *  - comparaison en temps constant (anti-timing),
 *  - fenêtre de fraîcheur (anti-rejeu), défaut 5 min.
 *
 * ⚠️ La signature DOIT être calculée sur le corps BRUT (bytes reçus), jamais sur
 * un objet re-sérialisé — d'où la lecture du raw body dans le serveur.
 */
import crypto from 'node:crypto';

export interface VerifyOptions {
  /** Tolérance d'horloge en secondes (défaut 300 = 5 min). */
  toleranceSeconds?: number;
  /** Horodatage courant (secondes epoch) — injectable pour les tests. */
  nowSeconds?: number;
}

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

interface ParsedHeader {
  timestamp: number;
  signatures: string[];
}

/** Horodatage : suite de chiffres UNIQUEMENT (voir `parseSignatureHeader`). */
const TIMESTAMP_RE = /^[0-9]{1,15}$/;

/**
 * `Number.parseInt` était bien trop laxiste : `t=abc` et `t=` donnaient NaN,
 * qui traversait le contrôle « mal formé » (`NaN < 0` est faux) PUIS la fenêtre
 * anti-rejeu (`NaN > 300` est faux aussi) — le contrôle de fraîcheur
 * s'auto-désarmait en silence. Et `t=300abc` valait 300, `t=1e10` valait 1,
 * `t=0x10` valait 0. On n'accepte donc qu'une suite de chiffres, et un seul `t`.
 */
function parseSignatureHeader(header: string): ParsedHeader {
  let timestamp = -1;
  let seenTimestamp = false;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key === 't') {
      // Un second `t` (valide ou non) rend l'en-tête ambigu : on le refuse.
      timestamp = seenTimestamp || !TIMESTAMP_RE.test(value) ? -1 : Number.parseInt(value, 10);
      seenTimestamp = true;
    } else if (key === 'v1') signatures.push(value);
  }
  return { timestamp, signatures };
}

/** Comparaison en temps constant de deux hex de même schéma. */
function timingSafeHexEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Vérifie la signature et renvoie le corps parsé. Lève `StripeSignatureError`
 * si l'en-tête est absent/mal formé, la signature invalide, ou l'horodatage
 * hors tolérance.
 *
 * @param rawBody  corps BRUT de la requête (string ou Buffer).
 * @param header   valeur de l'en-tête `Stripe-Signature`.
 * @param secret   `whsec_…` (Stripe Dashboard → Webhooks → Signing secret).
 */
export function verifyStripeSignature(
  rawBody: string | Buffer,
  header: string | undefined,
  secret: string,
  opts: VerifyOptions = {},
): unknown {
  if (!header) throw new StripeSignatureError('En-tête Stripe-Signature absent.');
  if (!secret) throw new StripeSignatureError('Secret de signature (whsec_…) non configuré.');

  const { timestamp, signatures } = parseSignatureHeader(header);
  if (!Number.isInteger(timestamp) || timestamp <= 0 || signatures.length === 0) {
    throw new StripeSignatureError('En-tête Stripe-Signature mal formé (t/v1 manquant ou invalide).');
  }

  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`, 'utf8')
    .digest('hex');

  const matched = signatures.some((sig) => timingSafeHexEqual(sig, expected));
  if (!matched) throw new StripeSignatureError('Signature Stripe invalide.');

  const tolerance = opts.toleranceSeconds ?? 300;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > tolerance) {
    throw new StripeSignatureError(
      `Horodatage hors tolérance (${Math.abs(now - timestamp)}s > ${tolerance}s) — rejeu probable.`,
    );
  }

  try {
    return JSON.parse(payload);
  } catch {
    throw new StripeSignatureError('Corps du webhook illisible (JSON invalide).');
  }
}
