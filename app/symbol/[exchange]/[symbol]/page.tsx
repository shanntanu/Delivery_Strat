import Link from "next/link";
import { notFound } from "next/navigation";
import { getSymbolDetail } from "../../../../lib/queries/symbol-detail";
import { SymbolChart } from "../../../../components/symbol-chart";

export const dynamic = "force-dynamic";

function fmtPct(v: number | null, digits = 2): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h2>
      {children}
    </div>
  );
}

export default async function SymbolDetailPage({
  params,
}: {
  params: Promise<{ exchange: string; symbol: string }>;
}) {
  const { exchange, symbol } = await params;
  const data = await getSymbolDetail(exchange.toUpperCase(), symbol.toUpperCase());

  if (data.notFound) notFound();

  const { header, dataQuality, strategyParams, strategyIsTuned, tuning, defaultComparison, signals, summary, chartBars, whatDidntWork } = data;

  return (
    <div className="space-y-4">
      <div>
        <Link href="/" className="text-sm text-[var(--color-text-muted)] hover:underline">
          ← Dashboard
        </Link>
      </div>

      {/* 1. Header */}
      <Card title="Header">
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <div>
            <div className="text-xl font-semibold">{header.symbol}</div>
            <div className="text-sm text-[var(--color-text-muted)]">
              {header.name ?? "—"} · {header.exchange}
            </div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-text-muted)]">Last close ({header.lastBarDate ?? "—"})</div>
            <div className="text-lg font-medium">{header.lastClose?.toFixed(2) ?? "—"}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--color-text-muted)]">Last-day delivery vs baseline</div>
            <div className="text-lg font-medium">
              {header.lastDeliveryQty !== null && header.lastDeliveryBaseline
                ? `${(header.lastDeliveryQty / header.lastDeliveryBaseline).toFixed(2)}×`
                : "—"}
              <span className="ml-2 text-sm text-[var(--color-text-muted)]">
                ({header.lastDeliveryPct?.toFixed(1) ?? "—"}% of volume)
              </span>
            </div>
          </div>
        </div>
      </Card>

      {/* 2. Data quality notice */}
      <Card title="Data quality">
        <div className="text-sm text-[var(--color-text-muted)]">
          Data covers {dataQuality.firstBarDate ?? "—"} to {dataQuality.lastBarDate ?? "—"}.
        </div>
        {dataQuality.corporateActions.length === 0 ? (
          <div className="mt-2 text-sm text-[var(--color-text-muted)]">No corporate actions detected or recorded.</div>
        ) : (
          <div className="mt-2 space-y-1">
            {dataQuality.corporateActions.map((a) => (
              <div key={a.exDate} className="flex items-center gap-2 text-sm">
                <span className="font-medium">{a.exDate}</span>
                <span>
                  {a.type} {a.ratioNumerator}:{a.ratioDenominator}
                </span>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs ${
                    a.confirmed
                      ? "border-[var(--color-green)]/40 text-[var(--color-green)]"
                      : "border-[var(--color-amber)]/40 text-[var(--color-amber)]"
                  }`}
                >
                  {a.confirmed ? "confirmed" : `unconfirmed (${a.source})`}
                </span>
              </div>
            ))}
          </div>
        )}
        {dataQuality.hasUnconfirmed && (
          <div className="mt-2 rounded border border-[var(--color-amber)]/30 bg-[var(--color-amber)]/10 px-3 py-2 text-xs">
            This symbol relies on at least one unconfirmed corporate action detection. Adjustments are applied, but
            review them in Admin before trusting exact figures.
          </div>
        )}
      </Card>

      {/* 5. Chart + 3. Signals table */}
      <Card title="Price, delivery, and signal windows">
        <SymbolChart bars={chartBars} signals={signals} />
      </Card>

      {/* 4. Summary statistics */}
      <Card title="Summary statistics">
        {summary.count === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">
            No signals found for this symbol with the current strategy.
          </div>
        ) : (
          <>
            <div className={`mb-3 rounded border px-3 py-2 text-xs ${summary.count < 8 ? "border-[var(--color-red)]/40 bg-[var(--color-red)]/10" : "border-[var(--color-border)]"}`}>
              {summary.count} signal{summary.count === 1 ? "" : "s"}
              {summary.count < 8 && " — below the ~8-signal minimum CLAUDE.md treats as reliable. Treat this result as unvalidated."}
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Mean return" value={fmtPct(summary.meanReturn)} />
              <Stat label="Median return" value={fmtPct(summary.medianReturn)} emphasize />
              <Stat label="Win rate" value={summary.winRate !== null ? `${summary.winRate.toFixed(0)}%` : "—"} />
              <Stat label="Max drawdown" value={fmtPct(summary.maxDrawdown)} />
              <Stat label="Random baseline (mean)" value={fmtPct(summary.randomBaselineMean)} />
              <Stat label="Random baseline (win rate)" value={summary.randomBaselineWinRate !== null ? `${summary.randomBaselineWinRate.toFixed(0)}%` : "—"} />
              <Stat label="Permutation p-value" value={summary.pValue !== null ? summary.pValue.toFixed(4) : "—"} />
            </div>
            <p className="mt-3 text-xs text-[var(--color-text-muted)]">
              Median is reported alongside mean deliberately — see CLAUDE.md §2.4: a mean/median gap is a right-skew
              warning, not a rounding detail. p-value computed live (2,000 random-entry permutations), not from a
              saved tuning run.
            </p>
          </>
        )}

        {tuning.status === "no_reliable_pattern" && (
          <div className="mt-3 rounded border border-[var(--color-grey)]/40 bg-[var(--color-grey)]/10 px-3 py-2 text-xs">
            Tuner ran ({tuning.combinationsSearched} combinations searched) and found no grid cell with at least 8
            signals in the training window — CLAUDE.md §9.1 refuses to emit a strategy in that case. This symbol is
            running the untouched default parameters, not a tuned fit.
          </div>
        )}

        {tuning.status === "tuned" && (
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-2 gap-4 rounded border border-[var(--color-border)] p-3 text-xs sm:grid-cols-4">
              <Stat label="Combinations searched" value={String(tuning.combinationsSearched)} />
              <Stat label="Train median (first 70%)" value={fmtPct(tuning.trainMedianReturn)} />
              <Stat label="Test median (last 30%, OOS)" value={fmtPct(tuning.testMedianReturn)} />
              <Stat
                label="OOS agreement"
                value={tuning.oosAgrees ? "agrees" : "sign flip"}
              />
            </div>
            {!tuning.oosAgrees && (
              <div className="rounded border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-xs">
                Out-of-sample sign flip: the tuned parameters' return sign differs between the training split (first
                70% of history) and the untouched last 30%. Per CLAUDE.md §9.1, treat this tuned result as likely
                overfit to the training window rather than a real edge.
              </div>
            )}
            {defaultComparison && (
              <div className="overflow-x-auto rounded border border-[var(--color-border)]">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--color-bg)]">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium text-[var(--color-text-muted)]">Variant</th>
                      <th className="px-2 py-1.5 text-left font-medium text-[var(--color-text-muted)]">Signals</th>
                      <th className="px-2 py-1.5 text-left font-medium text-[var(--color-text-muted)]">Median</th>
                      <th className="px-2 py-1.5 text-left font-medium text-[var(--color-text-muted)]">Mean</th>
                      <th className="px-2 py-1.5 text-left font-medium text-[var(--color-text-muted)]">Win rate</th>
                      <th className="px-2 py-1.5 text-left font-medium text-[var(--color-text-muted)]">p-value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-t border-[var(--color-border)]">
                      <td className="px-2 py-1.5 text-[var(--color-text-muted)]">Default (untouched)</td>
                      <td className="px-2 py-1.5">{defaultComparison.count}</td>
                      <td className="px-2 py-1.5">{fmtPct(defaultComparison.medianReturn)}</td>
                      <td className="px-2 py-1.5">{fmtPct(defaultComparison.meanReturn)}</td>
                      <td className="px-2 py-1.5">{defaultComparison.winRate !== null ? `${defaultComparison.winRate.toFixed(0)}%` : "—"}</td>
                      <td className="px-2 py-1.5">{defaultComparison.pValue !== null ? defaultComparison.pValue.toFixed(4) : "—"}</td>
                    </tr>
                    <tr className="border-t border-[var(--color-border)] font-medium">
                      <td className="px-2 py-1.5">Tuned (current)</td>
                      <td className="px-2 py-1.5">{summary.count}</td>
                      <td className="px-2 py-1.5">{fmtPct(summary.medianReturn)}</td>
                      <td className="px-2 py-1.5">{fmtPct(summary.meanReturn)}</td>
                      <td className="px-2 py-1.5">{summary.winRate !== null ? `${summary.winRate.toFixed(0)}%` : "—"}</td>
                      <td className="px-2 py-1.5">{summary.pValue !== null ? summary.pValue.toFixed(4) : "—"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* 6. What didn't work */}
      <Card title="What didn't work">
        <div className="space-y-3">
          {whatDidntWork.map((w) => (
            <div key={w.label} className="rounded border border-[var(--color-border)] p-3">
              <div className="flex items-center justify-between">
                <span className="font-medium">{w.label}</span>
                <span className="text-xs text-[var(--color-text-muted)]">{w.count} occurrence{w.count === 1 ? "" : "s"}</span>
              </div>
              <p className="mt-1 text-xs text-[var(--color-text-muted)]">{w.description}</p>
              {w.count > 0 && (
                <div className="mt-2 flex gap-4 text-sm">
                  <span>Mean {fmtPct(w.meanReturn)}</span>
                  <span>Median {fmtPct(w.medianReturn)}</span>
                  <span>Win rate {w.winRate !== null ? `${w.winRate.toFixed(0)}%` : "—"}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* 7. Current parameters card */}
      <Card title="Current parameters">
        <div className="mb-3 flex items-center justify-between">
          <span
            className={`rounded-full border px-2 py-0.5 text-xs ${
              strategyIsTuned
                ? "border-[var(--color-green)]/40 text-[var(--color-green)]"
                : "border-[var(--color-grey)]/40 text-[var(--color-grey)]"
            }`}
          >
            {strategyIsTuned ? "tuned" : "default"}
          </span>
          <Link
            href={`/symbol/${header.exchange}/${header.symbol}/strategy`}
            className="rounded border border-[var(--color-border)] px-3 py-1 text-sm hover:bg-[var(--color-bg)]"
          >
            Edit
          </Link>
        </div>
        {strategyParams && (
          <pre className="overflow-x-auto rounded bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
            {JSON.stringify(strategyParams, null, 2)}
          </pre>
        )}
      </Card>
    </div>
  );
}

function Stat({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div>
      <div className="text-xs text-[var(--color-text-muted)]">{label}</div>
      <div className={emphasize ? "text-lg font-semibold" : "text-base"}>{value}</div>
    </div>
  );
}
