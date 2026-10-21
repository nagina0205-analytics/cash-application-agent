// Cash application API (Express on Node.js, PostgreSQL).
//
//   POST /payments                    ingest a payment; the agent decides and records it
//   GET  /payments/:id/decision       the decision with its full trace
//   GET  /review-queue                payments waiting for a person, biggest first
//   POST /review-queue/:id/approve    apply the agent's suggested match  {"reviewer": "name"}
//   GET  /metrics                     straight-through rate, cash auto-applied, decisions by rule
//
//   DATABASE_URL=postgres://... npm start
import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { defaultExtractor, processPayment, type Extractor } from "./agent";
import { PgStore } from "./pg-store";
import type { Payment } from "./types";

export function validatePayment(b: Partial<Payment>): string[] {
  const errors: string[] = [];
  if (!b.id || typeof b.id !== "string") errors.push("id is required");
  if (typeof b.amount !== "number" || !(b.amount > 0)) errors.push("amount must be a positive number");
  if (!b.receivedDate || !/^\d{4}-\d{2}-\d{2}$/.test(b.receivedDate)) errors.push("receivedDate must be YYYY-MM-DD");
  if (!["ach", "check", "card"].includes(b.method as string)) errors.push("method must be ach, check or card");
  if (!b.payerName || typeof b.payerName !== "string") errors.push("payerName is required");
  if (b.remittance !== undefined && typeof b.remittance !== "string") errors.push("remittance must be text");
  return errors;
}

export function createApp(store: PgStore, extract: Extractor = defaultExtractor()) {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      if (process.env.LOG_REQUESTS) console.log(JSON.stringify({ method: req.method, path: req.path, status: res.statusCode, ms: +ms.toFixed(1) }));
    });
    next();
  });
  const fail = (res: Response, status: number, error: string, details?: unknown) => res.status(status).json({ error, details });

  app.post("/payments", async (req: Request, res: Response) => {
    const body = { remittance: "", ...req.body } as Payment;
    const errors = validatePayment(body);
    if (errors.length) return fail(res, 400, "invalid payment", errors);
    try {
      await store.pool.query("INSERT INTO payments VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING",
        [body.id, body.receivedDate, body.amount, body.method, body.payerName, body.remittance]);
      const d = await processPayment(store, body, extract);
      res.status(201).json(d);
    } catch (e) { fail(res, 500, (e as Error).message); }
  });

  app.get("/payments/:id/decision", async (req, res) => {
    const { rows } = await store.pool.query("SELECT * FROM decisions WHERE payment_id = $1", [req.params.id]);
    if (!rows.length) return fail(res, 404, "no decision for this payment");
    res.json(rows[0]);
  });

  app.get("/review-queue", async (_req, res) => res.json(await store.reviewQueue()));

  app.post("/review-queue/:id/approve", async (req, res) => {
    const reviewer = req.body?.reviewer;
    if (!reviewer || typeof reviewer !== "string") return fail(res, 400, "reviewer is required");
    try {
      await store.approve(req.params.id, reviewer);
      res.json({ ok: true });
    } catch (e) { fail(res, 409, (e as Error).message); }
  });

  app.get("/metrics", async (_req, res) => res.json(await store.metrics()));
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const store = PgStore.connect();
  await store.migrate();
  const port = Number(process.env.PORT ?? 3000);
  createApp(store).listen(port, () => console.log(`cash application API on http://localhost:${port}`));
}
