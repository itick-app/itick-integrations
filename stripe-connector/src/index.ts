/**
 * Point d'entrée du connecteur Stripe → ITICK.
 * Lit la configuration depuis l'environnement et démarre le serveur.
 *
 *   ITICK_API_KEY            (requis)  clé API ITICK (itick_sandbox_… ou itick_…)
 *   STRIPE_WEBHOOK_SECRET    (requis)  secret de signature Stripe (whsec_…)
 *   ITICK_BASE_URL           (opt.)    défaut https://api.itick.fr/itick
 *   PORT                     (opt.)    défaut 3000
 *   HOST                     (opt.)    défaut 127.0.0.1 (derrière un reverse-proxy TLS ;
 *                                      mettez 0.0.0.0 dans un conteneur)
 *   WEBHOOK_PATH             (opt.)    défaut /webhooks/stripe
 *   STRIPE_EVENTS            (opt.)    liste CSV, défaut invoice.paid
 *   MERCHANT_SIRET           (requis)  votre SIRET (14 chiffres) — exigé par ITICK
 *   MERCHANT_EMAIL           (requis)  votre email émetteur — exigé par ITICK
 *   MERCHANT_PHONE           (requis)  votre téléphone — exigé par ITICK
 *   MERCHANT_NAME            (opt.)    votre raison sociale (sinon account_name Stripe)
 *   DEFAULT_VAT_RATE         (opt.)    TVA % des lignes SANS taux Stripe. AUCUN défaut :
 *                                      non renseignée, une telle facture est refusée
 *                                      (le connecteur n'invente pas de TVA). 0 = franchise.
 */
import { createConnectorServer, type ConnectorConfig } from './server.js';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[stripe-connector] variable d'environnement requise manquante : ${name}`);
    process.exit(1);
  }
  return v;
}

/**
 * Lecture STRICTE du taux par défaut. `Number.parseFloat` tronquait en silence
 * (« 5,5 » → 5, « 20% » → 20) et laissait passer NaN — un taux faux part alors
 * dans un document certifié. Ici, une valeur inexploitable arrête le service au
 * démarrage plutôt que de fausser des factures.
 */
function optionalVatRate(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  // La virgule décimale française est acceptée explicitement, pas tronquée.
  const value = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    console.error(
      `[stripe-connector] ${name} invalide (« ${raw} ») : attendu un pourcentage entre 0 et 100, ` +
        'par exemple 20, 5.5 ou 0 (franchise en base de TVA).',
    );
    process.exit(1);
  }
  return value;
}

const defaultVatRate = optionalVatRate('DEFAULT_VAT_RATE');

const mapOptions: ConnectorConfig['mapOptions'] = {
  merchantSiret: required('MERCHANT_SIRET'),
  merchantEmail: required('MERCHANT_EMAIL'),
  merchantPhone: required('MERCHANT_PHONE'),
  ...(process.env['MERCHANT_NAME'] ? { merchantName: process.env['MERCHANT_NAME'] } : {}),
  ...(defaultVatRate !== undefined ? { defaultVatRate } : {}),
};

const config: ConnectorConfig = {
  itickApiKey: required('ITICK_API_KEY'),
  stripeWebhookSecret: required('STRIPE_WEBHOOK_SECRET'),
  ...(process.env['ITICK_BASE_URL'] ? { itickBaseUrl: process.env['ITICK_BASE_URL'] } : {}),
  ...(process.env['WEBHOOK_PATH'] ? { webhookPath: process.env['WEBHOOK_PATH'] } : {}),
  ...(process.env['STRIPE_EVENTS']
    ? { events: process.env['STRIPE_EVENTS'].split(',').map((s) => s.trim()).filter(Boolean) }
    : {}),
  mapOptions,
};

const port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
// Le service détient une clé API ITICK et ne fait pas de TLS : par défaut il
// n'écoute donc QUE la boucle locale, derrière un reverse-proxy qui termine le
// HTTPS. Dans un conteneur (Docker), posez explicitement HOST=0.0.0.0.
const host = process.env['HOST'] ?? '127.0.0.1';
const server = createConnectorServer(config);

server.listen(port, host, () => {
  console.log(`[stripe-connector] à l'écoute sur ${host}:${port}${config.webhookPath ?? '/webhooks/stripe'}`);
  console.log(`[stripe-connector] événements : ${(config.events ?? ['invoice.paid']).join(', ')}`);
});

// Arrêt propre (SIGTERM Docker / Ctrl-C).
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    console.log(`[stripe-connector] ${sig} reçu, arrêt…`);
    server.close(() => process.exit(0));
  });
}

