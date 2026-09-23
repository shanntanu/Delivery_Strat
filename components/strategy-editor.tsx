"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { StrategyParams } from "../lib/engine/types";
import { previewStrategy, saveStrategy, resetToDefault, type PreviewResult } from "../app/symbol/[exchange]/[symbol]/strategy/actions";

function Field({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="flex items-center gap-1 text-xs text-[var(--color-text-muted)]" title={tooltip}>
        {label}
        <span className="cursor-help rounded-full border border-[var(--color-border)] px-1 text-[10px] leading-tight">?</span>
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

const inputClass =
  "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]";

export function StrategyEditor({
  exchange,
  symbol,
  defaultParams,
  startingParams,
  isCustomActive,
}: {
  exchange: string;
  symbol: string;
  defaultParams: StrategyParams;
  startingParams: StrategyParams;
  isCustomActive: boolean;
}) {
  const router = useRouter();
  const [params, setParams] = useState<StrategyParams>(startingParams);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [isPreviewing, startPreview] = useTransition();
  const [isSaving, startSave] = useTransition();
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);

  // Live preview — debounced re-run on every param change (CLAUDE.md §10.3).
  useEffect(() => {
    const timeout = setTimeout(() => {
      startPreview(async () => {
        const result = await previewStrategy(exchange, symbol, params);
        setPreview(result);
      });
    }, 400);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(params)]);

  function update<K extends keyof StrategyParams>(section: K, patch: Partial<StrategyParams[K]>) {
    setSaved(false);
    setParams((p) => ({ ...p, [section]: { ...(p[section] as object), ...patch } }));
  }

  function updateTop(patch: Partial<StrategyParams>) {
    setSaved(false);
    setParams((p) => ({ ...p, ...patch }));
  }

  const isDirty = useMemo(() => JSON.stringify(params) !== JSON.stringify(startingParams), [params, startingParams]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <Section title="Window">
          <Field label="Window days" tooltip="Number of consecutive days the surge must sustain over. CLAUDE.md study: 4-day windows outperformed 5-day (~+5.3% vs ~+3%).">
            <input
              type="number"
              className={inputClass}
              value={params.window_days}
              onChange={(e) => updateTop({ window_days: Number(e.target.value) })}
            />
          </Field>
        </Section>

        <Section title="Baseline">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Lookback days" tooltip="How many days before the window to compute the 'normal' delivery/trades baseline from. Default 20 (one trading month).">
              <input
                type="number"
                className={inputClass}
                value={params.baseline.lookback_days}
                onChange={(e) => update("baseline", { lookback_days: Number(e.target.value) })}
              />
            </Field>
            <Field label="Method" tooltip="Median resists being skewed by one prior spike; a single earlier surge would inflate a mean baseline and hide the next real one.">
              <select
                className={inputClass}
                value={params.baseline.method}
                onChange={(e) => update("baseline", { method: e.target.value as "median" | "mean" })}
              >
                <option value="median">median</option>
                <option value="mean">mean</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Delivery">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Min ratio (each day)" tooltip="Every single day in the window must clear this delivery/baseline ratio. This is what separates sustained interest from one violent day — the core of the pattern.">
              <input type="number" step="0.1" className={inputClass} value={params.delivery.min_ratio_each_day} onChange={(e) => update("delivery", { min_ratio_each_day: Number(e.target.value) })} />
            </Field>
            <Field label="Avg ratio min" tooltip="Window-mean delivery/baseline must be at least this.">
              <input type="number" step="0.1" className={inputClass} value={params.delivery.avg_ratio_min} onChange={(e) => update("delivery", { avg_ratio_min: Number(e.target.value) })} />
            </Field>
            <Field label="Avg ratio max" tooltip="Upper cap — counter-intuitive but empirical: the study's 2-3x bucket returned +6.8%/10d at 88% win rate, while 3-5x returned only +1.8%. Extreme surges are more often news/bulk-deal driven than accumulation. Do not remove this cap.">
              <input type="number" step="0.1" className={inputClass} value={params.delivery.avg_ratio_max} onChange={(e) => update("delivery", { avg_ratio_max: Number(e.target.value) })} />
            </Field>
          </div>
        </Section>

        <Section title="Trades">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Enabled" tooltip="Whether the trades-ratio filter gates signals at all.">
              <input type="checkbox" checked={params.trades.enabled} onChange={(e) => update("trades", { enabled: e.target.checked })} />
            </Field>
            <Field label="Min avg ratio" tooltip="Window-mean trades/baseline must clear this — corroborates the delivery surge with genuinely more transactions, not just bigger ones.">
              <input type="number" step="0.1" className={inputClass} value={params.trades.min_avg_ratio} onChange={(e) => update("trades", { min_avg_ratio: Number(e.target.value) })} />
            </Field>
          </div>
        </Section>

        <Section title="Price">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cumulative change min %" tooltip="Delivery counts both buyer and seller — it can't tell accumulation from distribution. Price direction is the only disambiguator; this is load-bearing, not a nicety.">
              <input type="number" step="0.5" className={inputClass} value={params.price.cum_change_min_pct} onChange={(e) => update("price", { cum_change_min_pct: Number(e.target.value) })} />
            </Field>
            <Field label="Cumulative change max %" tooltip="Windows that already ran too far (>~12-15%) showed a degraded forward edge and deeper drawdowns in the study.">
              <input type="number" step="0.5" className={inputClass} value={params.price.cum_change_max_pct} onChange={(e) => update("price", { cum_change_max_pct: Number(e.target.value) })} />
            </Field>
            <Field label="Min up-days" tooltip="How many of the window's days must individually close green.">
              <input type="number" className={inputClass} value={params.price.min_up_days} onChange={(e) => update("price", { min_up_days: Number(e.target.value) })} />
            </Field>
            <Field label="Require above SMA (days, comma-separated)" tooltip="Close must be above every listed simple moving average — a basic uptrend-context filter.">
              <input
                type="text"
                className={inputClass}
                value={params.price.require_above_sma.join(",")}
                onChange={(e) => update("price", { require_above_sma: e.target.value.split(",").map((s) => Number(s.trim())).filter((n) => !Number.isNaN(n)) })}
              />
            </Field>
          </div>
        </Section>

        <Section title="Filters">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Min delivery % (null = disabled)" tooltip="CLAUDE.md §2.3: delivery-% of volume was tested as a filter and made no meaningful difference to forward returns. Stored and displayed, not gated on, by default — leave null unless you have a specific reason.">
              <input
                type="number"
                className={inputClass}
                value={params.filters.min_delivery_pct ?? ""}
                placeholder="null"
                onChange={(e) => update("filters", { min_delivery_pct: e.target.value === "" ? null : Number(e.target.value) })}
              />
            </Field>
            <Field label="Min avg turnover (₹cr)" tooltip="Liquidity floor — illiquid scrips generate meaningless ratios (a stock delivering 400 shares normally trips a 1.3x filter on noise).">
              <input type="number" step="0.1" className={inputClass} value={params.filters.min_avg_turnover_cr} onChange={(e) => update("filters", { min_avg_turnover_cr: Number(e.target.value) })} />
            </Field>
          </div>
        </Section>

        <Section title="Execution">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Entry" tooltip="Entry timing. next_open (the default) avoids look-ahead bias — you can never actually trade the signal day's own close.">
              <select className={inputClass} value={params.execution.entry} onChange={(e) => update("execution", { entry: e.target.value as "next_open" | "signal_close" })}>
                <option value="next_open">next_open</option>
                <option value="signal_close">signal_close</option>
              </select>
            </Field>
            <Field label="Hold days" tooltip="The study found the edge materializes over ~10 sessions — a 5-day hold averaged only +1.1% at 57% win rate.">
              <input type="number" className={inputClass} value={params.execution.hold_days} onChange={(e) => update("execution", { hold_days: Number(e.target.value) })} />
            </Field>
            <Field label="Stop loss %" tooltip="7%, not 4-5% — mean adverse excursion was -3.4%; tighter stops cut the 10-day average from +5.3% to +3.3% by stopping out of eventual winners.">
              <input type="number" step="0.5" className={inputClass} value={params.execution.stop_loss_pct} onChange={(e) => update("execution", { stop_loss_pct: Number(e.target.value) })} />
            </Field>
            <Field label="Target % (null = none)" tooltip="A hard profit target caps upside in testing — leave null unless you have a specific reason.">
              <input type="number" className={inputClass} value={params.execution.target_pct ?? ""} placeholder="null" onChange={(e) => update("execution", { target_pct: e.target.value === "" ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Trailing stop % (null = off)" tooltip="Optional trailing stop, replaces the fixed stop when set.">
              <input type="number" className={inputClass} value={params.execution.trailing_stop_pct ?? ""} placeholder="null" onChange={(e) => update("execution", { trailing_stop_pct: e.target.value === "" ? null : Number(e.target.value) })} />
            </Field>
            <Field label="Cooldown days" tooltip="Suppresses a new signal within N trading days of the last one, so one surge doesn't produce a dozen overlapping near-duplicate signals.">
              <input type="number" className={inputClass} value={params.execution.cooldown_days} onChange={(e) => update("execution", { cooldown_days: Number(e.target.value) })} />
            </Field>
          </div>
        </Section>

        <Section title="Costs">
          <div className="grid grid-cols-3 gap-3">
            <Field label="Brokerage (bps)" tooltip="Round-trip brokerage assumption in basis points.">
              <input type="number" className={inputClass} value={params.costs.brokerage_bps} onChange={(e) => update("costs", { brokerage_bps: Number(e.target.value) })} />
            </Field>
            <Field label="Slippage (bps)" tooltip="Assumed slippage per leg in basis points.">
              <input type="number" className={inputClass} value={params.costs.slippage_bps} onChange={(e) => update("costs", { slippage_bps: Number(e.target.value) })} />
            </Field>
            <Field label="Include STT" tooltip="Securities Transaction Tax on delivery trades. CLAUDE.md §10.4: costs are on by default — a backtest that ignores them on a 10-day hold isn't a useful number.">
              <input type="checkbox" checked={params.costs.include_stt} onChange={(e) => update("costs", { include_stt: e.target.checked })} />
            </Field>
          </div>
        </Section>
      </div>

      {/* Live preview + save panel */}
      <div className="h-fit space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">Live preview</h3>
        {isPreviewing && !preview ? (
          <div className="text-sm text-[var(--color-text-muted)]">Running…</div>
        ) : preview ? (
          <div className="space-y-2 text-sm">
            <div className={`rounded border px-2 py-1 text-xs ${preview.signalCount < 8 ? "border-[var(--color-red)]/40" : "border-[var(--color-green)]/40"}`}>
              {preview.signalCount} signal{preview.signalCount === 1 ? "" : "s"}
              {preview.signalCount < 8 && " (below reliable minimum)"}
              {isPreviewing && " · updating…"}
            </div>
            <div>Median return: <strong>{preview.medianReturn !== null ? `${preview.medianReturn.toFixed(2)}%` : "—"}</strong></div>
            <div>Mean return: {preview.meanReturn !== null ? `${preview.meanReturn.toFixed(2)}%` : "—"}</div>
            <div>Win rate: {preview.winRate !== null ? `${preview.winRate.toFixed(0)}%` : "—"}</div>
          </div>
        ) : (
          <div className="text-sm text-[var(--color-text-muted)]">—</div>
        )}

        <hr className="border-[var(--color-border)]" />

        <input
          type="text"
          placeholder="Strategy name (optional)"
          className={inputClass}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          disabled={!isDirty || isSaving}
          onClick={() =>
            startSave(async () => {
              await saveStrategy(exchange, symbol, params, name);
              setSaved(true);
              router.refresh();
            })
          }
          className="w-full rounded bg-[var(--color-green)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
        >
          {isSaving ? "Saving…" : "Save as new strategy"}
        </button>
        {saved && <div className="text-xs text-[var(--color-green)]">Saved. Strategy history is append-only — this is revertible.</div>}

        <button
          onClick={() =>
            startSave(async () => {
              await resetToDefault(exchange, symbol);
              setParams(defaultParams);
              router.refresh();
            })
          }
          className="w-full rounded border border-[var(--color-border)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg)]"
        >
          Reset to default
        </button>
        {isCustomActive && <div className="text-xs text-[var(--color-amber)]">A custom strategy is currently active for this symbol.</div>}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{title}</h3>
      {children}
    </div>
  );
}
