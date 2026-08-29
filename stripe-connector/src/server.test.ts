import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { ItickIngestError, type ItickClient, type PushReceiptInput, type PushOptions, type PushResult } from '@itick/ingest';
import { createConnectorServer } from './server.js';

const SECRET = 'whsec_srv';
const SIGNED_AT = 1_751_990_400;
const silentLogger = { log() {}, warn() {}, error() {} };

function sign(body: string, t = SIGNED_AT): string {
  const v1 = crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

function invoiceEventBody(id = 'evt_1', invoiceOverrides: Record<string, unknown> = {}, livemode = true): string {
  return JSON.stringify({
    id,
    type: 'invoice.paid',
    // La clé ITICK des tests (`itick_x`) est une clé de production : les
    // événements doivent donc être en livemode (voir la garde LIVEMODE_MISMATCH).
    livemode,
    data: {
      object: {
        id: 'in_1',
        created: SIGNED_AT,
        currency: 'eur',
        customer_email: 'client@example.com',
        account_name: 'Shop',
        lines: { data: [{ description: 'Article', quantity: 1, amount: 1000, tax_rates: [{ percentage: 20 }] }] },
        ...invoiceOverrides,
      },
    },
  });
}

/** Client ITICK factice : enregistre les appels, réponse programmable. */
function fakeClient(impl?: (input: PushReceiptInput, opts: PushOptions) => Promise<PushResult>) {
  const calls: Array<{ input: PushReceiptInput; opts: PushOptions }> = [];
  const client = {
    async pushReceipt(input: PushReceiptInput, opts: PushOptions = {}): Promise<PushResult> {
      calls.push({ input, opts });
      if (impl) return impl(input, opts);
      return { receiptId: 'r_1', invoiceNumber: 'INV-1', matched: true };
    },
  } as unknown as ItickClient;
  return { client, calls };
}

async function withServer(
  client: ItickClient,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const server: http.Server = createConnectorServer(
    {
      itickApiKey: 'itick_x',
      stripeWebhookSecret: SECRET,
      mapOptions: { merchantSiret: '12345678901234', merchantEmail: 'shop@example.com', merchantPhone: '+33100000000' },
      now: () => SIGNED_AT + 10,
    },
    { client, logger: silentLogger },
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function post(base: string, body: string, headers: Record<string, string>) {
  return fetch(`${base}/webhooks/stripe`, { method: 'POST', body, headers });
}

test('invoice.paid signée → pousse le reçu mappé + 200, idempotence = evt id', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const body = invoiceEventBody('evt_42');
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { receiptId: string; matched: boolean };
    assert.equal(json.receiptId, 'r_1');
    assert.equal(calls.length, 1);
    const input = calls[0]!.input as { merchantName: string; merchantPhone: string; customerEmail: string; items: unknown[] };
    assert.equal(input.merchantName, 'Shop');
    assert.equal(input.merchantPhone, '+33100000000');
    assert.equal(input.customerEmail, 'client@example.com');
    assert.equal(input.items.length, 1);
    assert.equal(calls[0]!.opts.idempotencyKey, 'stripe-evt-evt_42');
  });
});

test('signature invalide → 400, aucun push, et AUCUN détail de configuration renvoyé', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const body = invoiceEventBody();
    const res = await post(base, body, { 'stripe-signature': 't=1,v1=deadbeef' });
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
    // Le motif reste dans le log de l'opérateur : le renvoyer à un appelant non
    // authentifié en ferait un oracle (secret configuré ? décalage d'horloge ?).
    const json = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(json, { error: 'INVALID_SIGNATURE' });
  });
});

test('en-tête de signature absent → 400 sans détail non plus', async () => {
  const { client } = fakeClient();
  await withServer(client, async (base) => {
    const res = await post(base, invoiceEventBody(), {});
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'INVALID_SIGNATURE' });
  });
});

test('corps au-delà de la limite → 413 explicite, pas une connexion coupée', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const oversized = 'x'.repeat(2_000_000);
    const res = await post(base, oversized, { 'stripe-signature': 't=1,v1=deadbeef' });
    assert.equal(res.status, 413, 'Stripe doit voir un refus définitif, pas un incident à rejouer');
    assert.deepEqual(await res.json(), { error: 'PAYLOAD_TOO_LARGE' });
    assert.equal(calls.length, 0);
  });
});

test('événement non abonné → 200 ignoré, aucun push', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const body = JSON.stringify({ id: 'evt_x', type: 'customer.created', data: { object: { id: 'cus_1' } } });
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { ignored: string };
    assert.equal(json.ignored, 'customer.created');
    assert.equal(calls.length, 0);
  });
});

test('doublon ITICK (409) → 200 idempotent', async () => {
  const { client } = fakeClient(async () => {
    throw new ItickIngestError(409, { error: 'DUPLICATE_RECEIPT_DETECTED', existingReceiptId: 'r_prev' });
  });
  await withServer(client, async (base) => {
    const body = invoiceEventBody();
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { duplicate: boolean; receiptId: string };
    assert.equal(json.duplicate, true);
    assert.equal(json.receiptId, 'r_prev');
  });
});

test('erreur transitoire ITICK (500) → 500 pour déclencher le retry Stripe', async () => {
  const { client } = fakeClient(async () => {
    throw new ItickIngestError(503, { error: 'SERVICE_UNAVAILABLE' });
  });
  await withServer(client, async (base) => {
    const body = invoiceEventBody();
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 500);
  });
});

test('payload rejeté par ITICK (422) → 200 (non rejouable), pas de retry infini', async () => {
  const { client } = fakeClient(async () => {
    throw new ItickIngestError(422, { error: 'VALIDATION_ERROR' });
  });
  await withServer(client, async (base) => {
    const body = invoiceEventBody();
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { rejected: string };
    assert.equal(json.rejected, 'VALIDATION_ERROR');
  });
});

test('événement de TEST reçu avec une clé ITICK de PRODUCTION → refusé, aucun push', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const body = invoiceEventBody('evt_test', {}, false);
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { rejected: string };
    assert.equal(json.rejected, 'LIVEMODE_MISMATCH');
    assert.equal(calls.length, 0, 'une facture de test ne doit jamais être certifiée');
  });
});

test('événement sans livemode (forme inattendue) → refusé, aucun push', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const body = JSON.stringify({
      id: 'evt_nolive',
      type: 'invoice.paid',
      data: { object: { id: 'in_x', created: SIGNED_AT, currency: 'eur', customer_email: null, lines: { data: [] } } },
    });
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { rejected: string }).rejected, 'LIVEMODE_MISMATCH');
    assert.equal(calls.length, 0);
  });
});

test('facture non représentable (devise étrangère) → 200 motivé, aucun push', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const body = invoiceEventBody('evt_usd', { currency: 'usd' });
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    const json = (await res.json()) as { rejected: string; message: string };
    assert.equal(json.rejected, 'UNSUPPORTED_CURRENCY');
    assert.match(json.message, /devise/);
    assert.equal(calls.length, 0, 'rien ne doit être certifié');
  });
});

test('facture avec ligne négative → 200 motivé, aucun push', async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const body = invoiceEventBody('evt_neg', {
      lines: { data: [{ description: 'Unused time', quantity: 1, amount: -500, tax_rates: [{ percentage: 20 }] }] },
    });
    const res = await post(base, body, { 'stripe-signature': sign(body) });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { rejected: string }).rejected, 'NEGATIVE_LINE');
    assert.equal(calls.length, 0);
  });
});

test('GET /health → 200', async () => {
  const { client } = fakeClient();
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
  });
});
