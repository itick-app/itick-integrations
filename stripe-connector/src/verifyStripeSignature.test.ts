import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { StripeSignatureError, verifyStripeSignature } from './verifyStripeSignature.js';

const SECRET = 'whsec_test_secret';

function sign(body: string, secret: string, t: number): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`, 'utf8').digest('hex');
  return `t=${t},v1=${v1}`;
}

test('signature valide + horodatage frais → renvoie le JSON parsé', () => {
  const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid' });
  const t = 1000;
  const header = sign(body, SECRET, t);
  const parsed = verifyStripeSignature(body, header, SECRET, { nowSeconds: t + 10 }) as { id: string };
  assert.equal(parsed.id, 'evt_1');
});

test('corps altéré après signature → signature invalide', () => {
  const body = JSON.stringify({ amount: 100 });
  const header = sign(body, SECRET, 1000);
  assert.throws(
    () => verifyStripeSignature(body + ' ', header, SECRET, { nowSeconds: 1000 }),
    StripeSignatureError,
  );
});

test('mauvais secret → signature invalide', () => {
  const body = 'x';
  const header = sign(body, 'whsec_autre', 1000);
  assert.throws(() => verifyStripeSignature(body, header, SECRET, { nowSeconds: 1000 }), StripeSignatureError);
});

test('en-tête absent → erreur', () => {
  assert.throws(() => verifyStripeSignature('x', undefined, SECRET), StripeSignatureError);
});

test('en-tête mal formé (pas de v1) → erreur', () => {
  assert.throws(() => verifyStripeSignature('x', 't=1000', SECRET, { nowSeconds: 1000 }), StripeSignatureError);
});

test('horodatage périmé au-delà de la tolérance → rejeu refusé', () => {
  const body = 'x';
  const t = 1000;
  const header = sign(body, SECRET, t);
  assert.throws(
    () => verifyStripeSignature(body, header, SECRET, { nowSeconds: t + 400, toleranceSeconds: 300 }),
    StripeSignatureError,
  );
});

test('accepte plusieurs v1 (rotation de secret) si l’un correspond', () => {
  const body = JSON.stringify({ ok: true });
  const t = 1000;
  const good = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  const header = `t=${t},v1=deadbeef,v1=${good}`; // 1er v1 invalide, 2e valide
  const parsed = verifyStripeSignature(body, header, SECRET, { nowSeconds: t }) as { ok: boolean };
  assert.equal(parsed.ok, true);
});

test('horodatage non numérique → REFUSÉ (il neutralisait la fenêtre anti-rejeu)', () => {
  // `Number.parseInt('abc')` = NaN : NaN < 0 est faux (garde « mal formé »
  // franchie) ET NaN > tolérance est faux (fenêtre anti-rejeu franchie).
  for (const t of ['abc', '', '   ', '0x10', '1e10', '-1', '0', '300abc', '3.5']) {
    const header = `t=${t},v1=deadbeef`;
    assert.throws(
      () => verifyStripeSignature('x', header, SECRET, { nowSeconds: 1000 }),
      StripeSignatureError,
      `t=${JSON.stringify(t)} doit être refusé`,
    );
  }
});

test('horodatage non numérique : refusé MÊME avec une signature valide', () => {
  // Le vrai risque : un `t` illisible désarmait le contrôle de fraîcheur.
  const body = 'x';
  const v1 = crypto.createHmac('sha256', SECRET).update(`NaN.${body}`, 'utf8').digest('hex');
  assert.throws(
    () => verifyStripeSignature(body, `t=abc,v1=${v1}`, SECRET, { nowSeconds: 1000 }),
    (e: unknown) => e instanceof StripeSignatureError && /mal formé/.test(e.message),
  );
});

test('deux horodatages dans l’en-tête → ambigu, refusé', () => {
  const t = 1000;
  const body = 'x';
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`, 'utf8').digest('hex');
  assert.throws(
    () => verifyStripeSignature(body, `t=abc,t=${t},v1=${v1}`, SECRET, { nowSeconds: t }),
    StripeSignatureError,
  );
});

test('corps signé mais non-JSON → erreur explicite', () => {
  const body = 'pas du json';
  const header = sign(body, SECRET, 1000);
  assert.throws(() => verifyStripeSignature(body, header, SECRET, { nowSeconds: 1000 }), StripeSignatureError);
});
