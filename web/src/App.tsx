import { Fragment, useMemo, useState } from "react";
import { generate } from "../../src/data/generate";
import { offlineExtract } from "../../src/extract";
import { decide } from "../../src/match";
import type { Decision, Invoice, Payment } from "../../src/types";
import evals from "../../reports/eval_results.json";

const money = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const label = (s: string) => s.replace(/_/g, " ");

type Row = { payment: Payment; decision: Decision; status: "auto applied" | "needs review" | "approved" };

// Run the real matcher over one batch of synthetic payments, in the browser.
function runBatch() {
  const data = generate(1, 160);
  const invoices = new Map<string, Invoice>(data.invoices.map(i => [i.id, { ...i }]));
  const rows: Row[] = [];
  const ordered = [...data.payments].sort((a, b) => a.receivedDate.localeCompare(b.receivedDate) || a.id.localeCompare(b.id));
  for (const p of ordered) {
    const open = [...invoices.values()].filter(i => i.balance > 0.004);
    const d = decide(p, offlineExtract(p.remittance), data.customers, open);
    if (d.action === "auto_apply") for (const a of d.applications) {
      const inv = invoices.get(a.invoiceId)!;
      inv.balance = Math.round((inv.balance - a.amount - a.discount) * 100) / 100;
    }
    rows.push({ payment: p, decision: d, status: d.action === "auto_apply" ? "auto applied" : "needs review" });
  }
  return { rows, invoices, customers: data.customers };
}

export default function App() {
  const initial = useMemo(runBatch, []);
  const [rows, setRows] = useState(initial.rows);
  const [invoices] = useState(initial.invoices);
  const [filter, setFilter] = useState<"all" | "auto applied" | "needs review" | "approved">("needs review");
  const [open, setOpen] = useState<string | null>(null);
  const [trial, setTrial] = useState({ payer: "RIDGELINE BLDRS", amount: "", remittance: "" });
  const [trialResult, setTrialResult] = useState<Decision | null>(null);

  const auto = rows.filter(r => r.status === "auto applied");
  const cashAuto = auto.reduce((a, r) => a + r.payment.amount, 0);
  const shown = rows.filter(r => filter === "all" || r.status === filter);

  const approve = (id: string) => setRows(rs => rs.map(r => {
    if (r.payment.id !== id || !r.decision.applications.length) return r;
    for (const a of r.decision.applications) {
      const inv = invoices.get(a.invoiceId)!;
      inv.balance = Math.round((inv.balance - a.amount - a.discount) * 100) / 100;
    }
    return { ...r, status: "approved" };
  }));

  const tryPayment = () => {
    const amount = Number(trial.amount);
    if (!(amount > 0)) return;
    const p: Payment = { id: "TRY", receivedDate: "2026-10-20", amount, method: "ach", payerName: trial.payer, remittance: trial.remittance };
    setTrialResult(decide(p, offlineExtract(p.remittance), initial.customers, [...invoices.values()].filter(i => i.balance > 0.004)));
  };
  const sample = [...invoices.values()].find(i => i.customerId === "C001" && i.balance > 0);

  return (
    <main>
      <header>
        <h1>Cash Application Agent</h1>
        <p className="sub">Applies customer payments to open invoices for a construction materials supplier, and sends anything uncertain to the AR team with a reason. All data is synthetic. <a href="https://github.com/nagina0205-analytics/cash-application-agent">Code and evals</a></p>
      </header>

      <section className="stats">
        <div><strong>{pct(auto.length / rows.length)}</strong><span>applied with no human touch</span></div>
        <div><strong>{money(cashAuto)}</strong><span>cash applied automatically</span></div>
        <div><strong>{rows.filter(r => r.status === "needs review").length}</strong><span>waiting for review</span></div>
        <div><strong>{evals.holdout.wrongAutoApplications + evals.stress.wrongAutoApplications}</strong><span>wrong applications in evals</span></div>
      </section>

      <section className="card">
        <h2>Payments</h2>
        <div className="tabs">
          {(["needs review", "auto applied", "approved", "all"] as const).map(f => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
              {f} ({f === "all" ? rows.length : rows.filter(r => r.status === f).length})
            </button>
          ))}
        </div>
        <div className="scroll">
          <table>
            <thead><tr><th>Payer</th><th>Amount</th><th>Remittance</th><th>Decision</th><th></th></tr></thead>
            <tbody>
              {shown.slice(0, 40).map(({ payment: p, decision: d, status }) => (
                <Fragment key={p.id}>
                  <tr onClick={() => setOpen(open === p.id ? null : p.id)} className="row">
                    <td>{p.payerName}</td>
                    <td className="num">{money(p.amount)}</td>
                    <td className="remit">{p.remittance || <em>none</em>}</td>
                    <td><span className={`badge ${status.replace(" ", "-")}`}>{status}</span><div className="reason">{d.reason}</div></td>
                    <td>{status === "needs review" && d.applications.length > 0 &&
                      <button className="approve" onClick={e => { e.stopPropagation(); approve(p.id); }}>Approve suggestion</button>}</td>
                  </tr>
                  {open === p.id && (
                    <tr className="trace"><td colSpan={5}>
                      <strong>Rule:</strong> {label(d.rule)} · <strong>Confidence:</strong> {d.confidence.toFixed(2)}
                      {d.applications.length > 0 && <> · <strong>{status === "auto applied" ? "Applied" : "Suggested"}:</strong> {d.applications.map(a => `${a.invoiceId} ${money(a.amount)}${a.discount ? ` (+${money(a.discount)} discount)` : ""}`).join(", ")}</>}
                      <ol>{d.trace.map((t, i) => <li key={i}>{t}</li>)}</ol>
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {shown.length > 40 && <p className="note">Showing 40 of {shown.length}. Click a row to see every step the agent took.</p>}
      </section>

      <section className="card">
        <h2>Try a payment</h2>
        <p className="note">The agent runs in your browser against the open invoices above.{sample && <> For example, invoice {sample.id} for Ridgeline Builders has {money(sample.balance)} open.</>}</p>
        <div className="form">
          <label>Payer<input value={trial.payer} onChange={e => setTrial({ ...trial, payer: e.target.value })} /></label>
          <label>Amount<input value={trial.amount} inputMode="decimal" placeholder={sample ? String(sample.balance) : "0.00"} onChange={e => setTrial({ ...trial, amount: e.target.value })} /></label>
          <label className="wide">Remittance<input value={trial.remittance} placeholder={sample ? `INV ${sample.id}` : ""} onChange={e => setTrial({ ...trial, remittance: e.target.value })} /></label>
          <button onClick={tryPayment}>Run the agent</button>
        </div>
        {trialResult && (
          <div className="result">
            <span className={`badge ${trialResult.action === "auto_apply" ? "auto-applied" : "needs-review"}`}>{trialResult.action === "auto_apply" ? "would auto-apply" : "would go to review"}</span>
            <p>{trialResult.reason}</p>
            <ol>{trialResult.trace.map((t, i) => <li key={i}>{t}</li>)}</ol>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Evals</h2>
        <div className="scroll">
          <table>
            <thead><tr><th>Metric</th><th>Development</th><th>Held-out</th><th>Stress (hand-written)</th></tr></thead>
            <tbody>
              <tr><td>Payments</td><td>{evals.dev.payments}</td><td>{evals.holdout.payments}</td><td>{evals.stress.payments}</td></tr>
              <tr><td>Wrong auto-applications</td><td>{evals.dev.wrongAutoApplications}</td><td>{evals.holdout.wrongAutoApplications}</td><td>{evals.stress.wrongAutoApplications}</td></tr>
              <tr><td>Straight-through rate</td><td>{pct(evals.dev.straightThroughRate)}</td><td>{pct(evals.holdout.straightThroughRate)}</td><td>{pct(evals.stress.straightThroughRate)}</td></tr>
              <tr><td>Correct escalations</td><td>{evals.dev.correctEscalations}/{evals.dev.shouldReview}</td><td>{evals.holdout.correctEscalations}/{evals.holdout.shouldReview}</td><td>{evals.stress.correctEscalations}/{evals.stress.shouldReview}</td></tr>
              <tr><td>Missed automation</td><td>{evals.dev.missedAutomation}</td><td>{evals.holdout.missedAutomation}</td><td>{evals.stress.missedAutomation}</td></tr>
            </tbody>
          </table>
        </div>
        <p className="note">The stress set is 20 hand-written cases the data generator never produces. Its lower straight-through rate is the honest number: every miss went to review instead of applying cash wrongly.</p>
      </section>
    </main>
  );
}
