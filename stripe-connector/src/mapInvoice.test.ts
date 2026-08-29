import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  StripeMappingError,
  mapStripeInvoiceToItick,
  type MapOptions,
  type StripeInvoiceLike,
} from './mapInvoice.js';

/** Identité émetteur : requise par ITICK en mode structuré. */
const BASE: MapOptions = {
  merchantSiret: '12345678901234',
  merchantEmail: 'facturation@enseigne.fr',
  merchantPhone: '+33100000000',
};

/** Même identité, avec un taux par défaut EXPLICITEMENT choisi par l'opérateur. */
const WITH_DEFAULT: MapOptions = { ...BASE, defaultVatRate: 20 };

function invoice(overrides: Partial<StripeInvoiceLike> = {}): StripeInvoiceLike {
  return {
    id: 'in_123',
    created: 1_751_990_400, // 2025-07-08T16:00:00Z
    currency: 'eur',
    customer_email: 'client@example.com',
    account_name: 'Boulangerie Test',
    lines: {
      data: [
        { description: 'Abonnement Pro', quantity: 1, amount: 5000, tax_rates: [{ percentage: 20 }] },
        { description: 'Installation', quantity: 2, amount: 3000, tax_rates: [{ percentage: 20 }] },
      ],
    },
    ...overrides,
  };
}

/** Une ligne isolée, pour cibler un cas de bord. */
function withLine(line: StripeInvoiceLike['lines']['data'][number]): StripeInvoiceLike {
  return invoice({ lines: { data: [line] } });
}

function rejects(inv: StripeInvoiceLike, opts: MapOptions, code: string, message: string): void {
  assert.throws(
    () => mapStripeInvoiceToItick(inv, opts),
    (e: unknown) => {
      assert.ok(e instanceof StripeMappingError, message);
      assert.equal(e.code, code, message);
      assert.ok(e.message.length > 20, 'le motif doit être lisible par un opérateur');
      return true;
    },
    message,
  );
}

test('mappe une facture Stripe complète vers un reçu structuré ITICK', () => {
  const r = mapStripeInvoiceToItick(invoice(), BASE);
  assert.equal(r.date, new Date(1_751_990_400 * 1000).toISOString());
  assert.equal(r.merchantName, 'Boulangerie Test');
  assert.equal(r.customerEmail, 'client@example.com');
  assert.equal(r.externalId, 'stripe-invoice-in_123');
  assert.equal(r.items.length, 2);
});

test('unitPriceHt = amount/100/quantity quand la division tombe juste', () => {
  const r = mapStripeInvoiceToItick(invoice(), BASE);
  assert.deepEqual(r.items[0], { name: 'Abonnement Pro', quantity: 1, unitPriceHt: 50, vatRate: 20 });
  // 3000 centimes = 30 €, /2 = 15 €
  assert.equal(r.items[1]?.unitPriceHt, 15);
  assert.equal(r.items[1]?.quantity, 2);
});

test('arrondi correct sur un montant non entier (2999 centimes / 1)', () => {
  const r = mapStripeInvoiceToItick(withLine({ description: 'X', quantity: 1, amount: 2999, tax_rates: [{ percentage: 20 }] }), BASE);
  assert.equal(r.items[0]?.unitPriceHt, 29.99);
});

// --- Fidélité comptable : le total certifié doit être le total encaissé -----

test('le total de CHAQUE ligne est reconstitué au centime, même indivisible', () => {
  // ITICK recalcule le total depuis quantity × unitPriceHt : c'est CETTE
  // égalité qui doit tenir, sinon le document certifié diverge de Stripe.
  const cases: Array<[number, number]> = [
    [10_000, 7], // 100,00 € / 7 → arrondi naïf : 100,03 €
    [1_000, 3], //   10,00 € / 3 → arrondi naïf :   9,99 €
    [123_456, 999], // 1 234,56 € → arrondi naïf : 1 238,76 € (4,20 € d'écart)
    [300, 1_000], // 0,0003 € l'unité → arrondi naïf : ligne annulée à 0 €
    [1, 3],
    [5_000, 1],
    [3_000, 2],
  ];
  for (const [amount, quantity] of cases) {
    const r = mapStripeInvoiceToItick(
      withLine({ description: 'Consommation', quantity, amount, tax_rates: [{ percentage: 20 }] }),
      BASE,
    );
    const item = r.items[0]!;
    const reconstitue = Math.round(item.quantity * item.unitPriceHt * 100) / 100;
    assert.equal(
      reconstitue,
      amount / 100,
      `amount=${amount} q=${quantity} : total reconstitué ${reconstitue} € ≠ ${amount / 100} €`,
    );
    assert.ok(item.unitPriceHt > 0, 'une ligne payée ne peut pas tomber à 0 €');
  }
});

test('ligne indivisible : quantité regroupée à 1, quantité d’origine reportée dans le libellé', () => {
  const r = mapStripeInvoiceToItick(
    withLine({ description: 'Appels', quantity: 7, amount: 10_000, tax_rates: [{ percentage: 20 }] }),
    BASE,
  );
  const item = r.items[0]!;
  assert.equal(item.quantity, 1);
  assert.equal(item.unitPriceHt, 100);
  assert.match(item.name, /Appels \(× 7\)/);
  assert.match(item.description ?? '', /Quantité Stripe : 7/);
});

test('libellé long : le nom reste dans la borne ITICK de 255 caractères', () => {
  const r = mapStripeInvoiceToItick(
    withLine({ description: 'A'.repeat(300), quantity: 7, amount: 10_000, tax_rates: [{ percentage: 20 }] }),
    BASE,
  );
  assert.ok((r.items[0]?.name.length ?? 0) <= 255);
});

// --- TVA : jamais inventée --------------------------------------------------

test('vatRate vient du tax_rate de la ligne', () => {
  assert.equal(mapStripeInvoiceToItick(invoice(), BASE).items[0]?.vatRate, 20);
  const r = mapStripeInvoiceToItick(
    withLine({ description: 'Livre', quantity: 1, amount: 1_000, tax_rates: [{ percentage: 5.5 }] }),
    BASE,
  );
  assert.equal(r.items[0]?.vatRate, 5.5);
});

test('ligne sans taux Stripe SANS DEFAULT_VAT_RATE → facture REFUSÉE (aucune TVA inventée)', () => {
  for (const taxRates of [null, undefined, [], [{ percentage: null }], [{}]]) {
    rejects(
      withLine({ description: 'Installation', quantity: 1, amount: 3_000, tax_rates: taxRates as never }),
      BASE,
      'VAT_RATE_UNKNOWN',
      `tax_rates=${JSON.stringify(taxRates)} : aucun taux ne doit être fabriqué`,
    );
  }
});

test('ligne sans taux AVEC DEFAULT_VAT_RATE explicite → le taux choisi est appliqué', () => {
  const r = mapStripeInvoiceToItick(withLine({ description: 'Installation', quantity: 1, amount: 3_000, tax_rates: null }), WITH_DEFAULT);
  assert.equal(r.items[0]?.vatRate, 20);
  // Franchise en base : 0 est une valeur CHOISIE, pas un défaut implicite.
  const franchise = mapStripeInvoiceToItick(
    withLine({ description: 'Prestation', quantity: 1, amount: 3_000, tax_rates: null }),
    { ...BASE, defaultVatRate: 0 },
  );
  assert.equal(franchise.items[0]?.vatRate, 0);
});

test('le taux de la ligne prime sur DEFAULT_VAT_RATE', () => {
  const r = mapStripeInvoiceToItick(invoice(), { ...BASE, defaultVatRate: 5.5 });
  assert.equal(r.items[0]?.vatRate, 20);
});

test('defaultVatRate absurde (NaN, négatif, > 100) → refus', () => {
  for (const bad of [Number.NaN, -1, 101]) {
    rejects(invoice(), { ...BASE, defaultVatRate: bad }, 'VAT_RATE_UNKNOWN', `defaultVatRate=${bad}`);
  }
});

test('plusieurs taux de TVA sur une même ligne → refus (aucun taux arbitraire)', () => {
  rejects(
    withLine({ description: 'Panier mixte', quantity: 1, amount: 3_000, tax_rates: [{ percentage: 20 }, { percentage: 5.5 }] }),
    WITH_DEFAULT,
    'MULTIPLE_TAX_RATES',
    'deux taux sur une ligne ne sont pas représentables',
  );
});

// --- Devise -----------------------------------------------------------------

test('devise non-EUR → facture REFUSÉE (jamais certifiée comme des euros)', () => {
  for (const currency of ['usd', 'jpy', 'kwd', 'gbp', '']) {
    rejects(invoice({ currency }), BASE, 'UNSUPPORTED_CURRENCY', `devise ${currency || '(vide)'}`);
  }
});

test('EUR accepté quelle que soit la casse', () => {
  assert.equal(mapStripeInvoiceToItick(invoice({ currency: 'EUR' }), BASE).items.length, 2);
});

// --- Lignes négatives -------------------------------------------------------

test('ligne négative (prorata, avoir) → facture REFUSÉE, jamais perdue en silence', () => {
  rejects(
    invoice({
      lines: {
        data: [
          { description: 'Remaining time on Pro', quantity: 1, amount: 5_000, tax_rates: [{ percentage: 20 }] },
          { description: 'Unused time on Starter', quantity: 1, amount: -1_200, tax_rates: [{ percentage: 20 }] },
        ],
      },
    }),
    BASE,
    'NEGATIVE_LINE',
    'un prorata négatif ne peut pas être certifié en mode structuré',
  );
});

// --- Divers -----------------------------------------------------------------

test('quantité nulle/0/absente → 1 (jamais de division par zéro)', () => {
  const r = mapStripeInvoiceToItick(
    invoice({
      lines: {
        data: [
          { description: 'A', quantity: null, amount: 1200, tax_rates: [{ percentage: 20 }] },
          { description: 'B', quantity: 0, amount: 1200, tax_rates: [{ percentage: 20 }] },
        ],
      },
    }),
    BASE,
  );
  assert.equal(r.items[0]?.quantity, 1);
  assert.equal(r.items[0]?.unitPriceHt, 12);
  assert.equal(r.items[1]?.quantity, 1);
});

test('description manquante → « Article »', () => {
  const r = mapStripeInvoiceToItick(withLine({ description: null, quantity: 1, amount: 100, tax_rates: [{ percentage: 20 }] }), BASE);
  assert.equal(r.items[0]?.name, 'Article');
});

test('merchantName : opts > account_name > défaut', () => {
  assert.equal(mapStripeInvoiceToItick(invoice(), { ...BASE, merchantName: 'Mon Enseigne' }).merchantName, 'Mon Enseigne');
  assert.equal(mapStripeInvoiceToItick(invoice({ account_name: null }), BASE).merchantName, 'Commerçant');
});

test('customerEmail absent quand la facture n’en a pas (pas de clé vide)', () => {
  const r = mapStripeInvoiceToItick(invoice({ customer_email: null }), BASE);
  assert.equal('customerEmail' in r, false);
});

test('SIRET / email / téléphone émetteur propagés depuis les options (requis ITICK)', () => {
  const r = mapStripeInvoiceToItick(invoice(), BASE);
  assert.equal(r.merchantSiret, '12345678901234');
  assert.equal(r.merchantEmail, 'facturation@enseigne.fr');
  assert.equal(r.merchantPhone, '+33100000000');
});
