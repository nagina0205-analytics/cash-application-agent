// Score the agent against payments with known right answers.
//
//   npx tsx src/evals.ts             offline extractor
//   npx tsx src/evals.ts --llm       Claude extractor (needs ANTHROPIC_API_KEY)
//
// The metrics that matter for cash application:
//   wrong auto-applications   cash applied to the wrong invoice or amount. Target: 0.
//   auto-apply precision      share of auto-applied payments that were right.
//   straight-through rate     share of payments applied with no human touch.
//   correct escalations       payments that needed a person and went to one.
//   missed automation         payments the agent could have applied but sent to review.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultExtractor, processAll, type Extractor } from "./agent";
import { generate } from "./data/generate";
import { stressSet } from "./data/stress";
import { offlineExtract } from "./extract";
import { MemoryStore } from "./store";
import type { Dataset, Decision, Truth } from "./types";

export const DEV_SEED = 1;
export const HOLDOUT_SEED = 2;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export interface EvalResult {
  payments: number;
  autoApplied: number;
  wrongAutoApplications: number;
  autoApplyPrecision: number;
  straightThroughRate: number;
  shouldReview: number;
  correctEscalations: number;
  missedAutomation: number;
  byScenario: Record<string, { total: number; correct: number }>;
}

function isCorrectApplication(d: Decision, t: Truth): boolean {
  if (t.expected !== "apply" || d.customerId !== t.customerId) return false;
  const want = new Map(t.applications.map(a => [a.invoiceId, a.amount]));
  return d.applications.length === want.size &&
    d.applications.every(a => want.has(a.invoiceId) && Math.abs(want.get(a.invoiceId)! - a.amount) < 0.005);
}

export function score(decisions: Decision[], truth: Truth[]): EvalResult {
  const byId = new Map(truth.map(t => [t.paymentId, t]));
  const auto = decisions.filter(d => d.action === "auto_apply");
  const wrong = auto.filter(d => !isCorrectApplication(d, byId.get(d.paymentId)!));
  const shouldReview = truth.filter(t => t.expected === "review");
  const escalated = new Set(decisions.filter(d => d.action === "review").map(d => d.paymentId));
  const byScenario: EvalResult["byScenario"] = {};
  for (const d of decisions) {
    const t = byId.get(d.paymentId)!;
    const ok = t.expected === "review" ? d.action === "review" : d.action === "auto_apply" && isCorrectApplication(d, t);
    byScenario[t.scenario] ??= { total: 0, correct: 0 };
    byScenario[t.scenario].total++;
    if (ok) byScenario[t.scenario].correct++;
  }
  return {
    payments: decisions.length,
    autoApplied: auto.length,
    wrongAutoApplications: wrong.length,
    autoApplyPrecision: auto.length ? (auto.length - wrong.length) / auto.length : 1,
    straightThroughRate: (auto.length - wrong.length) / decisions.length,
    shouldReview: shouldReview.length,
    correctEscalations: shouldReview.filter(t => escalated.has(t.paymentId)).length,
    missedAutomation: truth.filter(t => t.expected === "apply" && escalated.has(t.paymentId)).length,
    byScenario,
  };
}

export async function evaluate(data: Dataset, extract: Extractor) {
  const store = new MemoryStore(data.customers, data.invoices);
  const decisions = await processAll(store, data.payments, extract);
  return { result: score(decisions, data.truth), decisions };
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

async function main() {
  const useLlm = process.argv.includes("--llm");
  if (useLlm && !process.env.ANTHROPIC_API_KEY) throw new Error("--llm needs ANTHROPIC_API_KEY");
  const extract: Extractor = useLlm ? defaultExtractor() : async t => offlineExtract(t);
  const mode = useLlm ? "llm" : "offline";
  const dev = await evaluate(generate(DEV_SEED, 160), extract);
  const hold = await evaluate(generate(HOLDOUT_SEED, 90), extract);
  const stress = await evaluate(stressSet(), extract);

  const stressTruth = new Map(stressSet().truth.map(t => [t.paymentId, t]));
  const rows: [string, (r: EvalResult) => string][] = [
    ["Payments", r => String(r.payments)],
    ["Wrong auto-applications", r => String(r.wrongAutoApplications)],
    ["Auto-apply precision", r => pct(r.autoApplyPrecision)],
    ["Straight-through rate", r => pct(r.straightThroughRate)],
    ["Correct escalations", r => `${r.correctEscalations}/${r.shouldReview}`],
    ["Missed automation (sent to review, could have applied)", r => String(r.missedAutomation)],
  ];
  const scen = [...new Set([...Object.keys(dev.result.byScenario), ...Object.keys(hold.result.byScenario)])].sort();
  const lines = [
    "# Cash application eval report", "", `Extractor: **${mode}**  `, `Run: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, "",
    "| Metric | Development set (used while building) | Held-out set | Stress set (hand-written) |", "| --- | --- | --- | --- |",
    ...rows.map(([label, f]) => `| ${label} | ${f(dev.result)} | ${f(hold.result)} | ${f(stress.result)} |`),
    "", "The development and held-out sets come from the same generator with different seeds. The stress set is 20 hand-written",
    "cases the generator never produces, so it is the most honest of the three.", "",
    "## Stress set, case by case", "", "| Case | Expected | Agent | Result |", "| --- | --- | --- | --- |",
    ...stress.decisions.map(d => {
      const t = stressTruth.get(d.paymentId)!;
      const ok = t.expected === "review" ? d.action === "review" : d.action === "auto_apply";
      return `| ${t.scenario} | ${t.expected} | ${d.action.replace("_", " ")} (${d.rule.replace(/_/g, " ")}) | ${ok ? "correct" : d.action === "auto_apply" ? "WRONG" : "missed, sent to review"} |`;
    }),
    "", "## By scenario (generated sets)", "", "| Scenario | Development | Held-out |", "| --- | --- | --- |",
    ...scen.map(s => {
      const a = dev.result.byScenario[s], b = hold.result.byScenario[s];
      return `| ${s.replace(/_/g, " ")} | ${a ? `${a.correct}/${a.total}` : "-"} | ${b ? `${b.correct}/${b.total}` : "-"} |`;
    }),
  ];
  mkdirSync(join(ROOT, "reports"), { recursive: true });
  writeFileSync(join(ROOT, "reports", `eval_report${useLlm ? "_llm" : ""}.md`), lines.join("\n") + "\n");
  writeFileSync(join(ROOT, "reports", `eval_results${useLlm ? "_llm" : ""}.json`), JSON.stringify({ mode, dev: dev.result, holdout: hold.result, stress: stress.result }, null, 1));
  console.log(lines.slice(5, 14).join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error(e); process.exit(1); });
}
