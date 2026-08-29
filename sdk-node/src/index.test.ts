import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ItickClient,
  ItickIngestError,
  RETRY_BACKOFF_MS,
  type BatchResult,
  type PushReceiptInput,
  type StructuredReceipt,
} from './index.js';

// Racine du paquet (le test s'exécute compilé depuis dist-test/).
const SDK_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Payload structuré COMPLET : les 6 champs requis par le serveur. */
const structured: StructuredReceipt = {
  date: '2026-08-29T10:00:00Z',
  merchantSiret: '12345678901234',
  merchantName: 'Le Café du Coin',
  merchantEmail: 'contact@lecafe.fr',
  merchantPhone: '+33100000000',
  items: [{ name: 'Expresso', quantity: 2, unitPriceHt: 1.5, vatRate: 10 }],
  customerEmail: 'client@example.com',
  externalId: 'ticket-0001',
};

type Call = { url: string; init: RequestInit; headers: Record<string, string> };

/**
 * fetch factice : rejoue une séquence de réponses (une par appel) et capture
 * chaque requête. `'network'` simule une coupure (fetch rejette).
 */
function fakeFetch(sequence: Array<{ status: number; body: unknown } | 'network'>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> });
    const step = sequence[Math.min(calls.length - 1, sequence.length - 1)];
    if (step === undefined || step === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('pushReceipt structuré : POST /receipts/providers + auth + parse', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { receiptId: 'r1', invoiceNumber: 'INV-1', matched: true } }]);
  const client = new ItickClient({ apiKey: 'itick_sandbox_abc', fetch: impl });
  const res = await client.pushReceipt(structured);
  assert.equal(res.receiptId, 'r1');
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/receipts\/providers$/);
  assert.equal(calls[0]!.headers['Authorization'], 'Bearer itick_sandbox_abc');
  const sent = JSON.parse(calls[0]!.init.body as string) as StructuredReceipt;
  assert.equal(sent.merchantPhone, '+33100000000');
});

test('idempotencyKey fournie → header Idempotency-Key ; absente → UUID généré', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { receiptId: 'r2', invoiceNumber: 'INV-2', matched: false } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await client.pushReceipt(structured, { idempotencyKey: 'idem-123' });
  assert.equal(calls[0]!.headers['Idempotency-Key'], 'idem-123');
  await client.pushReceipt(structured);
  assert.match(calls[1]!.headers['Idempotency-Key']!, /^[0-9a-f-]{36}$/);
});

test('date : un objet Date est sérialisé en ISO 8601', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { receiptId: 'r', invoiceNumber: 'I', matched: false } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await client.pushReceipt({ ...structured, date: new Date('2026-08-29T10:00:00Z') });
  const sent = JSON.parse(calls[0]!.init.body as string) as { date: string };
  assert.equal(sent.date, '2026-08-29T10:00:00.000Z');
});

test('erreur 409 → ItickIngestError avec code + existingReceiptId, sans retry', async () => {
  const { impl, calls } = fakeFetch([
    { status: 409, body: { error: 'DUPLICATE_RECEIPT_DETECTED', message: 'déjà vu', existingReceiptId: 'r-old' } },
  ]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await assert.rejects(
    () => client.pushReceipt(structured),
    (e: unknown) => {
      assert.ok(e instanceof ItickIngestError);
      assert.equal(e.status, 409);
      assert.equal(e.code, 'DUPLICATE_RECEIPT_DETECTED');
      assert.equal(e.existingReceiptId, 'r-old');
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('erreur 400 VALIDATION_ERROR → details typés, AUCUN retry', async () => {
  const { impl, calls } = fakeFetch([
    {
      status: 400,
      body: {
        error: 'VALIDATION_ERROR',
        message: 'The request payload is invalid.',
        details: [{ field: 'merchantPhone', errors: ['merchantPhone must be a string'] }],
      },
    },
  ]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await assert.rejects(
    () => client.pushReceipt(structured),
    (e: unknown) => {
      assert.ok(e instanceof ItickIngestError);
      assert.equal(e.status, 400);
      assert.equal(e.code, 'VALIDATION_ERROR');
      assert.deepEqual(e.details, [{ field: 'merchantPhone', errors: ['merchantPhone must be a string'] }]);
      return true;
    },
  );
  assert.equal(calls.length, 1, 'un 400 est définitif : une seule requête');
});

test('retry : 503 puis 201 → succès, 2 requêtes, MÊME Idempotency-Key', async () => {
  const { impl, calls } = fakeFetch([
    { status: 503, body: { error: 'SERVICE_UNAVAILABLE' } },
    { status: 201, body: { receiptId: 'r-ok', invoiceNumber: 'INV-OK', matched: true } },
  ]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  const started = Date.now();
  const res = await client.pushReceipt(structured);
  assert.equal(res.receiptId, 'r-ok');
  assert.equal(calls.length, 2);
  const key = calls[0]!.headers['Idempotency-Key'];
  assert.ok(key);
  assert.equal(calls[1]!.headers['Idempotency-Key'], key);
  // Le backoff porte un jitter de ±20 % : on borne par le bas de la fourchette.
  assert.ok(Date.now() - started >= RETRY_BACKOFF_MS[0]! * 0.8 - 20, 'a attendu le 1er backoff (500 ms ± 20 %)');
});

test('retry : coupure réseau puis 201 → succès avec la même clé', async () => {
  const { impl, calls } = fakeFetch([
    'network',
    { status: 201, body: { receiptId: 'r-net', invoiceNumber: 'INV-NET', matched: false } },
  ]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  const res = await client.pushReceipt(structured, { idempotencyKey: 'net-1' });
  assert.equal(res.receiptId, 'r-net');
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.headers['Idempotency-Key'], 'net-1');
});

test('retries: 0 → un 503 est levé immédiatement, une seule requête', async () => {
  const { impl, calls } = fakeFetch([{ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 0 });
  await assert.rejects(
    () => client.pushReceipt(structured),
    (e: unknown) => e instanceof ItickIngestError && e.status === 503,
  );
  assert.equal(calls.length, 1);
});

test('retries invalide → erreur de construction', () => {
  assert.throws(() => new ItickClient({ apiKey: 'k', retries: -1 }), /retries/);
  assert.throws(() => new ItickClient({ apiKey: 'k', retries: 1.5 }), /retries/);
  assert.throws(() => new ItickClient({ apiKey: 'k', retries: 11 }), /retries/, 'borne haute');
});

test('timeoutMs invalide → erreur de construction (0 abandonnerait chaque tentative)', () => {
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => new ItickClient({ apiKey: 'k', timeoutMs }), /timeoutMs/, `timeoutMs=${timeoutMs}`);
  }
  assert.doesNotThrow(() => new ItickClient({ apiKey: 'k', timeoutMs: 1 }));
});

// --- Sécurité : la clé API ne doit fuir NULLE PART -------------------------

test('la clé API ne sort jamais du client : JSON.stringify, inspect, keys, spread', () => {
  const secret = 'itick_live_SECRET_DEMO_1234';
  const client = new ItickClient({ apiKey: secret, fetch: fakeFetch([]).impl });

  assert.equal(JSON.stringify(client).includes(secret), false, 'JSON.stringify fuit la clé');
  assert.equal(inspect(client, { depth: 5 }).includes(secret), false, 'util.inspect fuit la clé');
  assert.equal(JSON.stringify(Object.keys(client)).includes('apiKey'), false, 'apiKey énumérable');
  assert.equal(JSON.stringify({ ...client }).includes(secret), false, 'le spread fuit la clé');
  assert.equal(JSON.stringify({ ctx: { client } }).includes(secret), false, 'sérialisation imbriquée');
  // Ce que l'on montre à la place.
  assert.match(JSON.stringify(client), /\[redacted\]/);
});

test('apiKey mal formée : refusée à la construction, SANS recopier la valeur', () => {
  for (const bad of ['itick_live_A1B2C3\nD4E5F6', 'itick_live_A\rB', 'itick live', 'itick\tlive']) {
    assert.throws(
      () => new ItickClient({ apiKey: bad }),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /apiKey invalide/);
        assert.equal(e.message.includes('A1B2C3'), false, 'le message recopie la clé');
        assert.equal(e.message.includes(bad.trim()), false, 'le message recopie la clé');
        return true;
      },
      `clé rejetée : ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => new ItickClient({ apiKey: '   ' }), /apiKey requis/);
  // Une clé lue depuis un fichier (retour à la ligne final) reste acceptée, nettoyée.
  assert.doesNotThrow(() => new ItickClient({ apiKey: '  itick_sandbox_ok\n' }));
});

test('baseUrl : https exigé, http://localhost toléré, URL invalide refusée', () => {
  const ok = (baseUrl: string) => assert.doesNotThrow(() => new ItickClient({ apiKey: 'k', baseUrl }), baseUrl);
  const ko = (baseUrl: string, re: RegExp) => assert.throws(() => new ItickClient({ apiKey: 'k', baseUrl }), re, baseUrl);

  ok('https://api.itick.fr/itick');
  ok('http://localhost:3000');
  ok('http://127.0.0.1:3000/itick');
  ok('http://[::1]:3000');

  ko('http://api.itick.fr/itick', /https/);
  ko('http://evil.example.com', /https/);
  ko('ftp://api.itick.fr', /https/);
  ko('pas-une-url', /URL absolue/);
});

test("redirect: 'error' — le corps du reçu ne peut pas partir vers un autre hôte", async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { receiptId: 'r', invoiceNumber: 'I', matched: false } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await client.pushReceipt(structured);
  assert.equal(calls[0]!.init.redirect, 'error');
});

test('idempotencyKey invalide → refus local, aucune requête', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { receiptId: 'r', invoiceNumber: 'I', matched: false } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await assert.rejects(() => client.pushReceipt(structured, { idempotencyKey: 'a'.repeat(257) }), /idempotencyKey/);
  await assert.rejects(() => client.pushReceipt(structured, { idempotencyKey: 'clé\navec saut' }), /idempotencyKey/);
  assert.equal(calls.length, 0);
});

// --- Fidélité : le SDK ne doit jamais mentir sur ce qu'il a fait ----------

/** fetch factice qui renvoie un corps BRUT (non-JSON, vide, en-têtes libres). */
function rawFetch(sequence: Array<{ status: number; text: string; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> });
    const step = sequence[Math.min(calls.length - 1, sequence.length - 1)]!;
    return new Response(step.text === '' ? null : step.text, { status: step.status, headers: step.headers ?? {} });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test('2xx non conforme au contrat → erreur explicite, jamais un receiptId undefined', async () => {
  for (const step of [
    { status: 200, text: '<html>ok</html>' },
    { status: 201, text: '' },
    { status: 201, text: '{"receiptId": 42}' },
  ]) {
    const { impl } = rawFetch([step]);
    const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 0 });
    await assert.rejects(
      () => client.pushReceipt(structured),
      (e: unknown) => {
        assert.ok(e instanceof ItickIngestError, `statut ${step.status} : erreur typée attendue`);
        assert.equal(e.code, 'INVALID_RESPONSE');
        assert.match(e.message, /receiptId/);
        return true;
      },
      `corps ${JSON.stringify(step.text)}`,
    );
  }
});

test('pushBatch : un 200 sans results[] est refusé de la même façon', async () => {
  const { impl } = rawFetch([{ status: 200, text: '{"total":1}' }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 0 });
  await assert.rejects(
    () => client.pushBatch([structured]),
    (e: unknown) => e instanceof ItickIngestError && e.code === 'INVALID_RESPONSE',
  );
});

test('erreur non-JSON : le message est borné, la page HTML va dans rawBody tronqué', async () => {
  const page = `<html><head><title>502 Bad Gateway</title></head><body>${'x'.repeat(200_000)}</body></html>`;
  const { impl } = rawFetch([{ status: 502, text: page }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 0 });
  await assert.rejects(
    () => client.pushReceipt(structured),
    (e: unknown) => {
      assert.ok(e instanceof ItickIngestError);
      assert.equal(e.code, 'NON_JSON_RESPONSE');
      assert.ok(e.message.length < 600, `message de ${e.message.length} caractères`);
      assert.equal(e.message.includes('Bad Gateway'), false, 'la page ne doit pas être le message');
      assert.ok(e.rawBody !== undefined && e.rawBody.length < 400, 'extrait borné');
      return true;
    },
  );
});

test('409 IDEMPOTENCY_KEY_IN_PROGRESS est REJOUÉ avec la même clé (état transitoire)', async () => {
  const { impl, calls } = fakeFetch([
    { status: 409, body: { error: 'IDEMPOTENCY_KEY_IN_PROGRESS', message: 'en cours' } },
    { status: 201, body: { receiptId: 'r-idem', invoiceNumber: 'INV', matched: true } },
  ]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 1 });
  const res = await client.pushReceipt(structured, { idempotencyKey: 'cmd-1' });
  assert.equal(res.receiptId, 'r-idem');
  assert.equal(calls.length, 2, 'le 409 IN_PROGRESS doit être rejoué');
  assert.equal(calls[1]!.headers['Idempotency-Key'], 'cmd-1', 'rejeu avec la MÊME clé');
});

test('409 IDEMPOTENCY_KEY_IN_PROGRESS persistant → erreur typée après épuisement', async () => {
  const { impl, calls } = fakeFetch([{ status: 409, body: { error: 'IDEMPOTENCY_KEY_IN_PROGRESS' } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 1 });
  await assert.rejects(
    () => client.pushReceipt(structured),
    (e: unknown) => e instanceof ItickIngestError && e.status === 409,
  );
  assert.equal(calls.length, 2);
});

test('exception DÉFINITIVE de fetch : relancée tout de suite, aucun rejeu', async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    throw new RangeError('bug de programmation dans le fetch fourni');
  }) as unknown as typeof fetch;
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  const started = Date.now();
  await assert.rejects(() => client.pushReceipt(structured), RangeError);
  assert.equal(calls, 1, 'une erreur définitive ne se rejoue pas');
  assert.ok(Date.now() - started < 300, 'aucun backoff consommé');
});

test('redirection refusée : définitive, pas de rejeu', async () => {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    throw Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
  }) as unknown as typeof fetch;
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await assert.rejects(() => client.pushReceipt(structured), TypeError);
  assert.equal(calls, 1);
});

test('429 : l’en-tête Retry-After du serveur pilote l’attente', async () => {
  const { impl, calls } = rawFetch([
    { status: 429, text: '{"error":"RATE_LIMITED"}', headers: { 'retry-after': '0' } },
    { status: 201, text: '{"receiptId":"r-429","invoiceNumber":"INV","matched":false}' },
  ]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 1 });
  const started = Date.now();
  const res = await client.pushReceipt(structured);
  assert.equal(res.receiptId, 'r-429');
  assert.equal(calls.length, 2);
  assert.ok(Date.now() - started < 400, `Retry-After: 0 respecté (attendu < 400 ms, mesuré ${Date.now() - started} ms)`);
});

test('backoff : le jitter décale réellement l’attente (Math.random contrôlé)', async () => {
  const realRandom = Math.random;
  Math.random = () => 0; // borne basse du jitter : -20 %
  try {
    const { impl } = fakeFetch([
      { status: 503, body: { error: 'SERVICE_UNAVAILABLE' } },
      { status: 201, body: { receiptId: 'r-jit', invoiceNumber: 'INV', matched: false } },
    ]);
    const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 1 });
    const started = Date.now();
    await client.pushReceipt(structured);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < RETRY_BACKOFF_MS[0]! - 40, `sans jitter l'attente serait de 500 ms (mesuré ${elapsed} ms)`);
    assert.ok(elapsed >= RETRY_BACKOFF_MS[0]! * 0.8 - 30, `attente trop courte (${elapsed} ms)`);
  } finally {
    Math.random = realRandom;
  }
});

test('timeout : il couvre la LECTURE du corps, pas seulement les en-têtes', { timeout: 5_000 }, async () => {
  // En-têtes envoyés, puis le serveur se tait : l'appel doit être abandonné.
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"receiptId":'));
        signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
      },
    });
    return new Response(stream, { status: 201, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const client = new ItickClient({ apiKey: 'k', fetch: impl, timeoutMs: 200, retries: 0 });
  const started = Date.now();
  await assert.rejects(() => client.pushReceipt(structured));
  assert.ok(Date.now() - started < 3_000, 'la lecture du corps doit être interrompue par le timeout');
});

test('corps de réponse démesuré → erreur bornée, jamais mis en mémoire en entier', async () => {
  const { impl } = rawFetch([{ status: 200, text: 'x'.repeat(1_200_000) }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl, retries: 0 });
  await assert.rejects(
    () => client.pushReceipt(structured),
    (e: unknown) => {
      assert.ok(e instanceof ItickIngestError);
      assert.equal(e.code, 'RESPONSE_TOO_LARGE');
      assert.ok(e.message.length < 200);
      return true;
    },
  );
});

test('pushBatch 207 : httpStatus + statut PAR ITEM (created / error + details / doublon)', async () => {
  const serverBody = {
    total: 3,
    created: 1,
    failed: 2,
    results: [
      { index: 0, status: 'created', receiptId: 'r-a', invoiceNumber: '12345678901234-00001' },
      {
        index: 1,
        status: 'error',
        error: 'VALIDATION_ERROR',
        message: 'The item payload is invalid.',
        details: [{ field: 'items[0].vatRate', errors: ['vatRate must not be less than 0'] }],
      },
      {
        index: 2,
        status: 'error',
        error: 'DUPLICATE_RECEIPT_DETECTED',
        message: 'A receipt with the same content already exists.',
        existingReceiptId: 'r-old',
      },
    ],
  };
  const { impl, calls } = fakeFetch([{ status: 207, body: serverBody }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  const batch: BatchResult = await client.pushBatch([structured, structured, structured]);
  assert.match(calls[0]!.url, /\/receipts\/providers\/batch$/);
  assert.equal(batch.httpStatus, 207);
  assert.equal(batch.created, 1);
  assert.equal(batch.failed, 2);
  const [a, b, c] = batch.results;
  assert.equal(a?.status, 'created');
  if (a?.status === 'created') assert.equal(a.receiptId, 'r-a');
  assert.equal(b?.status, 'error');
  if (b?.status === 'error') {
    assert.equal(b.error, 'VALIDATION_ERROR');
    assert.equal(b.details?.[0]?.field, 'items[0].vatRate');
  }
  if (c?.status === 'error') assert.equal(c.existingReceiptId, 'r-old');
});

test('pushBatch 200 : httpStatus 200 quand tout est créé', async () => {
  const { impl } = fakeFetch([
    { status: 200, body: { total: 1, created: 1, failed: 0, results: [{ index: 0, status: 'created', receiptId: 'r', invoiceNumber: 'I' }] } },
  ]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  const batch = await client.pushBatch([structured]);
  assert.equal(batch.httpStatus, 200);
});

test('pushBatch : enveloppe refusée (400) → ItickIngestError, jamais par item', async () => {
  const { impl } = fakeFetch([{ status: 400, body: { error: 'VALIDATION_ERROR', message: 'The batch envelope is invalid.' } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await assert.rejects(() => client.pushBatch([structured]), (e: unknown) => e instanceof ItickIngestError && e.status === 400);
});

test('pushBatch borne à 100', async () => {
  const { impl } = fakeFetch([{ status: 200, body: { total: 0, created: 0, failed: 0, results: [] } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  const many: PushReceiptInput[] = Array.from({ length: 101 }, () => structured);
  await assert.rejects(() => client.pushBatch(many), /100 reçus maximum/);
});

test('pushDocument encode les octets en base64', async () => {
  const { impl, calls } = fakeFetch([{ status: 201, body: { receiptId: 'r3', invoiceNumber: 'INV-3', matched: false, mode: 'document' } }]);
  const client = new ItickClient({ apiKey: 'k', fetch: impl });
  await client.pushDocument(new TextEncoder().encode('%PDF-1.4'), { customerEmail: 'c@e.fr', totalTtc: 12.5 });
  const sent = JSON.parse(calls[0]!.init.body as string);
  assert.equal(sent.documentPdf, Buffer.from('%PDF-1.4').toString('base64'));
  assert.equal(sent.customerEmail, 'c@e.fr');
  assert.equal(sent.totalTtc, 12.5);
});

test('le quickstart du README passe le typage, et un payload sans merchantPhone le RATE', () => {
  const readme = readFileSync(path.join(SDK_ROOT, 'README.md'), 'utf8');
  const afterHeading = readme.slice(readme.indexOf('## Quickstart'));
  const match = /```ts\n([\s\S]*?)```/.exec(afterHeading);
  assert.ok(match, 'bloc ```ts du quickstart introuvable dans le README');
  const quickstart = match![1]!;
  assert.match(quickstart, /merchantPhone/, 'le quickstart doit envoyer les 6 champs requis');

  const dir = mkdtempSync(path.join(tmpdir(), 'itick-readme-'));
  try {
    writeFileSync(path.join(dir, 'quickstart.ts'), quickstart);
    // Contre-épreuve : l'ancien quickstart (0.1.0, sans merchantPhone) doit être
    // REFUSÉ par le compilateur — sinon `@ts-expect-error` devient inutilisé et tsc échoue.
    writeFileSync(
      path.join(dir, 'ancien-quickstart.ts'),
      [
        "import type { PushReceiptInput } from '@itick/ingest';",
        '// @ts-expect-error merchantPhone manquant : le serveur répondrait 400 VALIDATION_ERROR',
        "export const incomplet: PushReceiptInput = { date: '2026-08-29T10:00:00Z', merchantSiret: '12345678901234', merchantName: 'M', merchantEmail: 'm@e.fr', items: [{ name: 'X', quantity: 1, unitPriceHt: 1, vatRate: 20 }] };",
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Bundler',
          lib: ['ES2022'],
          types: ['node'],
          typeRoots: [path.join(SDK_ROOT, 'node_modules', '@types')],
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          baseUrl: '.',
          paths: { '@itick/ingest': [path.join(SDK_ROOT, 'src', 'index.ts')] },
        },
        files: ['quickstart.ts', 'ancien-quickstart.ts'],
      }),
    );
    const tsc = path.join(SDK_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    const run = spawnSync(process.execPath, [tsc, '-p', path.join(dir, 'tsconfig.json')], { encoding: 'utf8' });
    assert.equal(run.status, 0, `tsc a échoué :\n${run.stdout}\n${run.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
