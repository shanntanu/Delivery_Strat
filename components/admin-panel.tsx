"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  confirmCorporateAction,
  rejectCorporateAction,
  correctCorporateAction,
  addManualCorporateAction,
  triggerScan,
} from "../app/admin/actions";
import type { CorporateActionReviewRow } from "../lib/queries/admin";

const inputClass = "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]";

function CorporateActionRow({ action }: { action: CorporateActionReviewRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [num, setNum] = useState(action.ratioNumerator);
  const [den, setDen] = useState(action.ratioDenominator);
  const [type, setType] = useState<"split" | "bonus" | "consolidation">(action.type as "split" | "bonus" | "consolidation");
  const [isPending, startTransition] = useTransition();

  return (
    <div className="rounded border border-[var(--color-border)] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-medium">{action.symbol}</span>
          <span className="ml-2 text-[var(--color-text-muted)]">{action.exchange}</span>
          <span className="ml-2">{action.exDate}</span>
          <span className="ml-2">
            {action.type} {action.ratioNumerator}:{action.ratioDenominator} (×{action.adjFactor.toFixed(4)})
          </span>
        </div>
        <div className="flex gap-2">
          <button
            disabled={isPending}
            onClick={() => startTransition(async () => { await confirmCorporateAction(action.id); router.refresh(); })}
            className="rounded bg-[var(--color-green)] px-2 py-1 text-xs font-medium text-black"
          >
            Confirm
          </button>
          <button onClick={() => setEditing((e) => !e)} className="rounded border border-[var(--color-border)] px-2 py-1 text-xs">
            {editing ? "Cancel" : "Correct"}
          </button>
          <button
            disabled={isPending}
            onClick={() => startTransition(async () => { await rejectCorporateAction(action.id); router.refresh(); })}
            className="rounded bg-[var(--color-red)] px-2 py-1 text-xs font-medium text-black"
          >
            Reject
          </button>
        </div>
      </div>

      {editing && (
        <div className="mt-2 flex flex-wrap items-end gap-2 border-t border-[var(--color-border)] pt-2">
          <label className="text-xs">
            Ratio num
            <input type="number" className={inputClass} value={num} onChange={(e) => setNum(Number(e.target.value))} />
          </label>
          <label className="text-xs">
            Ratio den
            <input type="number" className={inputClass} value={den} onChange={(e) => setDen(Number(e.target.value))} />
          </label>
          <label className="text-xs">
            Type
            <select className={inputClass} value={type} onChange={(e) => setType(e.target.value as typeof type)}>
              <option value="split">split</option>
              <option value="bonus">bonus</option>
              <option value="consolidation">consolidation</option>
            </select>
          </label>
          <button
            disabled={isPending}
            onClick={() =>
              startTransition(async () => {
                await correctCorporateAction(action.id, num, den, type);
                router.refresh();
              })
            }
            className="rounded bg-[var(--color-amber)] px-2 py-1 text-xs font-medium text-black"
          >
            Save correction
          </button>
        </div>
      )}

      <div className="mt-2 grid grid-cols-2 gap-3 text-xs text-[var(--color-text-muted)]">
        <div>
          Before ({action.beforeBar?.date ?? "—"}): close {action.beforeBar?.close ?? "—"}
        </div>
        <div>
          After ({action.afterBar?.date ?? "—"}): prevClose {action.afterBar?.prevClose ?? "—"}, close {action.afterBar?.close ?? "—"}
        </div>
      </div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{action.notes}</div>
    </div>
  );
}

export function AdminPanel({ pendingActions }: { pendingActions: CorporateActionReviewRow[] }) {
  const router = useRouter();
  const [showAddForm, setShowAddForm] = useState(false);
  const [manualSymbol, setManualSymbol] = useState("");
  const [manualExDate, setManualExDate] = useState("");
  const [manualType, setManualType] = useState<"split" | "bonus" | "consolidation">("split");
  const [manualNum, setManualNum] = useState(1);
  const [manualDen, setManualDen] = useState(1);
  const [isAdding, startAdd] = useTransition();

  const [scanExchange, setScanExchange] = useState<"NSE" | "BSE">("NSE");
  const [scanStarted, setScanStarted] = useState(false);
  const [isTriggering, startTrigger] = useTransition();

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Corporate action review queue ({pendingActions.length} pending)
        </h2>
        {pendingActions.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">Nothing pending review.</div>
        ) : (
          <div className="space-y-2">
            {pendingActions.map((a) => (
              <CorporateActionRow key={a.id} action={a} />
            ))}
          </div>
        )}

        <button onClick={() => setShowAddForm((s) => !s)} className="mt-3 rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-surface)]">
          {showAddForm ? "Cancel" : "+ Add manual corporate action"}
        </button>

        {showAddForm && (
          <div className="mt-2 grid grid-cols-2 gap-2 rounded border border-[var(--color-border)] p-3 sm:grid-cols-5">
            <input placeholder="Symbol (e.g. RELIANCE)" className={inputClass} value={manualSymbol} onChange={(e) => setManualSymbol(e.target.value.toUpperCase())} />
            <input type="date" className={inputClass} value={manualExDate} onChange={(e) => setManualExDate(e.target.value)} />
            <select className={inputClass} value={manualType} onChange={(e) => setManualType(e.target.value as typeof manualType)}>
              <option value="split">split</option>
              <option value="bonus">bonus</option>
              <option value="consolidation">consolidation</option>
            </select>
            <input type="number" placeholder="Numerator" className={inputClass} value={manualNum} onChange={(e) => setManualNum(Number(e.target.value))} />
            <input type="number" placeholder="Denominator" className={inputClass} value={manualDen} onChange={(e) => setManualDen(Number(e.target.value))} />
            <button
              disabled={isAdding || !manualSymbol || !manualExDate}
              onClick={() =>
                startAdd(async () => {
                  await addManualCorporateAction("NSE", manualSymbol, manualExDate, manualType, manualNum, manualDen, "Added manually via Admin");
                  setShowAddForm(false);
                  setManualSymbol("");
                  setManualExDate("");
                  router.refresh();
                })
              }
              className="col-span-2 rounded bg-[var(--color-green)] px-3 py-1.5 text-sm font-medium text-black sm:col-span-1"
            >
              {isAdding ? "Adding…" : "Add"}
            </button>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Scan trigger</h2>
        <div className="rounded border border-[var(--color-amber)]/30 bg-[var(--color-amber)]/10 p-3 text-xs">
          Dev-time convenience only. A full NSE scan takes roughly an hour — this starts it in the background rather
          than blocking the page; check the scan run history below for progress. In production this should be a
          GitHub Actions dispatch instead (not yet wired up — Phase 7).
        </div>
        <div className="mt-2 flex items-center gap-2">
          <select className={inputClass + " w-32"} value={scanExchange} onChange={(e) => setScanExchange(e.target.value as "NSE" | "BSE")}>
            <option value="NSE">NSE</option>
            <option value="BSE">BSE</option>
          </select>
          <button
            disabled={isTriggering}
            onClick={() =>
              startTrigger(async () => {
                await triggerScan(scanExchange);
                setScanStarted(true);
                setTimeout(() => router.refresh(), 3000);
              })
            }
            className="rounded bg-[var(--color-green)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
          >
            {isTriggering ? "Starting…" : "Trigger scan"}
          </button>
          {scanStarted && <span className="text-xs text-[var(--color-green)]">Started — see scan run history below.</span>}
        </div>
      </section>
    </div>
  );
}
