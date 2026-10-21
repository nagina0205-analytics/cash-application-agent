# Cash Application Agent

Construction suppliers get paid by check, ACH and card, and the remittance notes are a mess: "pmt inv 10234 + 10236 less 2% disc", "PO 4471", "joint check", or nothing at all. Someone in accounts receivable matches every payment to the right invoices by hand. A wrong match is expensive. The customer looks paid when they aren't, or gets a collections call for money they already sent.

This agent does that matching. It reads the remittance (with Claude, or an offline extractor), matches the payment to open invoices in PostgreSQL, and applies the cash only when the evidence is unambiguous. Everything else goes to a review queue with a plain-language reason and a suggested match, so a person can approve it in one click.

**Live dashboard:** https://nagina0205-analytics.github.io/cash-application-agent/

Built with TypeScript, Node.js, Express, React and PostgreSQL. All customers, invoices and payments are synthetic.

## Results

| Metric | Development set | Held-out set | Stress set (hand-written) |
| --- | --- | --- | --- |
| Payments | 160 | 90 | 20 |
| Wrong auto-applications | **0** | **0** | **0** |
| Auto-apply precision | 100% | 100% | 100% |
| Straight-through rate | 80.6% | 78.9% | 50.0% |
| Correct escalations | 31/31 | 19/19 | 5/5 |
| Missed automation (sent to review, could have applied) | 0 | 0 | 5 |

Full report, including every stress case: [reports/eval_report.md](reports/eval_report.md). CI reruns it on every push.

**How to read this.** The development and held-out sets come from the same data generator with different seeds. Because I wrote the generator and the matcher, their near-perfect scores mostly show the two agree with each other. The **stress set** is the honest test: 20 hand-written payments from real AR situations the generator never produces, such as a check number next to the invoice number, a ZIP code in the remittance, one PO split across two invoices, and a duplicate payment.

On the first stress run the agent applied cash wrongly **zero** times, which is the number that matters most. It also sent 6 payments to review that a careful clerk would have applied. One was a real bug: a PO that covers two invoices only looked up one of them. I fixed it, and the stress score went from 45% to 50% straight-through. The other five are left in on purpose:

| Miss | Why it's left in |
| --- | --- |
| Check number next to the invoice | The offline extractor reads 104523 as an invoice. The Claude extractor is built for this. |
| ZIP code in the remittance | Same: 67202 looks like an invoice number to a regex. |
| Leading zeros on the invoice number | Same family; the LLM extractor normalizes it. |
| Discount taken on one of two invoices | A real logic gap. Next on the list. |
| Three invoices, no reference | By design. A three-invoice guess scores 0.86, below the 0.90 auto-apply threshold. |

Tuning the matcher until the stress set scored 100% would make it useless as a test, so these stay visible.

## How a decision is made

```
payment + remittance text
   |
   v
extract   Claude (forced tool call, JSON schema) or offline rules
   |      -> invoice numbers, PO numbers, claimed discount
   v
match     every reference is checked against open invoices in PostgreSQL
   |      payer name -> customer (handles "RIDGELINE BLDRS" for "Ridgeline Builders LLC")
   v
decide    exact reference ............ auto-apply (0.97)
          early-pay discount in window  auto-apply (0.94), discount written off
          unique amount, no reference . auto-apply (0.90)
          two-invoice combination ..... auto-apply (0.90)
          short pay, overpayment, late discount, unknown payer,
          payer paying someone else's invoice, ambiguous amount ... review, with a reason
   v
record    one PostgreSQL transaction: decision + trace + applications + new balances
```

**Guardrails**
- Nothing auto-applies below 0.90 confidence.
- Model output is never trusted directly. Every invoice number the extractor returns must exist as an open invoice before any cash moves.
- Each payment is recorded in one transaction with a unique key on the payment, so a retry can never apply cash twice.
- The balance update checks the open balance under a row lock, so two workers can't over-apply one invoice.
- If the Claude call fails, the agent falls back to the offline extractor rather than stalling the payment queue.

**Observability.** Every decision stores its full trace: what was extracted, which customer the payer matched and with what score, which rule fired, and how long it took. `GET /metrics` reports the straight-through rate, the cash applied automatically, and decisions by rule.

## API

```
POST /payments                     ingest a payment; the agent decides and records it
GET  /payments/:id/decision        the decision and its trace
GET  /review-queue                 payments waiting for a person, largest first
POST /review-queue/:id/approve     apply the suggested match  {"reviewer": "name"}
GET  /metrics                      straight-through rate, cash auto-applied, decisions by rule
```

## Tests

23 tests, run in CI against a real PostgreSQL 16 service:
- extractor rules, plus the Claude extractor with a fake client (no API calls)
- every decision rule
- **an eval gate:** the build fails if any eval set ever has a wrong auto-application
- PostgreSQL makes exactly the same decisions as the in-memory store
- retrying a payment never moves money twice
- the books balance: cash applied plus discounts equals the drop in open balances, to the cent
- review approvals apply once; the API validates input and reports metrics

Two bugs were caught by these tests while building: an untyped SQL parameter that broke the first cash application in PostgreSQL, and an "INV" prefix whose letter I was being read as the digit 1.

## Run it

```
npm install
npm test                                   # unit tests and eval gate (PostgreSQL tests skip without a database)
DATABASE_URL=postgres://... npm test       # everything, including PostgreSQL and the API
npm run evals                              # writes reports/eval_report.md
DATABASE_URL=postgres://... npm start      # API on http://localhost:3000
npm run dev:web                            # React dashboard
```

To use Claude for extraction, set `ANTHROPIC_API_KEY`. `npm run evals:llm` then writes a separate report, so the two extractors can be compared on the same payments. The Claude path is covered by tests with a fake client. Live model results only appear here once a key is added as a repository secret.

## What I'd build next

Handle a discount taken on only some invoices. Read remittance PDFs and email attachments, not just memo text. Let reviewers' corrections become new stress cases automatically, so the eval set grows from real mistakes.
