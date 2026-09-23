"use client";

import { useState, useTransition } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { runBacktest, type BacktestResult } from "../app/symbol/[exchange]/[symbol]/backtest/actions";
import type { StrategyOption } from "../lib/queries/backtest";

const inputClass = "w-full rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]";

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function BacktestPanel({
  exchange,
  symbol,
  strategyOptions,
  dataFrom,
  dataTo,
  label,
}: {
  exchange: string;
  symbol: string;
  strategyOptions: StrategyOption[];
  dataFrom: string;
  dataTo: string;
  label: string;
}) {
  const defaultStrategy = strategyOptions.find((s) => s.isActive) ?? strategyOptions[0];
  const [strategyId, setStrategyId] = useState<number>(defaultStrategy?.id ?? 0);
  const [from, setFrom] = useState(dataFrom);
  const [to, setTo] = useState(dataTo);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [isRunning, startRun] = useTransition();

  function run() {
    startRun(async () => {
      const r = await runBacktest(exchange, symbol, strategyId, from, to);
      setResult(r);
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{label}</h3>

      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 block text-xs text-[var(--color-text-muted)]">
          Strategy
          <select className={inputClass} value={strategyId} onChange={(e) => setStrategyId(Number(e.target.value))}>
            {strategyOptions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} {s.isDefault ? "(default)" : s.isTuned ? "(tuned)" : "(custom)"} {s.isActive ? "★" : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-[var(--color-text-muted)]">
          From
          <input type="date" className={inputClass} value={from} onChange={(e) => setFrom(e.target.value)} min={dataFrom} max={dataTo} />
        </label>
        <label className="block text-xs text-[var(--color-text-muted)]">
          To
          <input type="date" className={inputClass} value={to} onChange={(e) => setTo(e.target.value)} min={dataFrom} max={dataTo} />
        </label>
      </div>

      <button
        onClick={run}
        disabled={isRunning || !strategyId}
        className="w-full rounded bg-[var(--color-green)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
      >
        {isRunning ? "Running…" : "Run backtest"}
      </button>

      {result && (
        <div className="space-y-3">
          <div className={`rounded border px-2 py-1 text-xs ${result.metrics.count < 8 ? "border-[var(--color-red)]/40" : "border-[var(--color-green)]/40"}`}>
            {result.metrics.count} signal{result.metrics.count === 1 ? "" : "s"} in range
            {result.metrics.count < 8 && " — below reliable minimum"}
          </div>

          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
            <div>Mean: <strong>{fmtPct(result.metrics.meanReturn)}</strong></div>
            <div>Median: <strong>{fmtPct(result.metrics.medianReturn)}</strong></div>
            <div>Win rate: {result.metrics.winRate !== null ? `${result.metrics.winRate.toFixed(0)}%` : "—"}</div>
            <div>Profit factor: {result.metrics.profitFactor !== null ? (result.metrics.profitFactor === Infinity ? "∞" : result.metrics.profitFactor.toFixed(2)) : "—"}</div>
            <div>Best: {fmtPct(result.metrics.bestTrade)}</div>
            <div>Worst: {fmtPct(result.metrics.worstTrade)}</div>
            <div>Avg bars held: {result.metrics.avgBarsHeld?.toFixed(1) ?? "—"}</div>
            <div>Max consec. losses: {result.metrics.maxConsecutiveLosses}</div>
          </div>

          {result.equityCurve.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-[var(--color-text-muted)]">Equity curve (fixed position size)</div>
              <ResponsiveContainer width="100%" height={140}>
                <LineChart data={result.equityCurve} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#232b36" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#8b949e" }} minTickGap={40} />
                  <YAxis tick={{ fontSize: 9, fill: "#8b949e" }} width={40} domain={["auto", "auto"]} />
                  <Tooltip contentStyle={{ background: "#121821", border: "1px solid #232b36", fontSize: 12 }} labelStyle={{ color: "#e6edf3" }} />
                  <Line dataKey="equity" stroke="#3fb950" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}

          {Object.keys(result.returnsByYear).length > 0 && (
            <div>
              <div className="mb-1 text-xs text-[var(--color-text-muted)]">By year</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-[var(--color-text-muted)]">
                    <th className="text-left">Year</th>
                    <th className="text-right">Signals</th>
                    <th className="text-right">Mean</th>
                    <th className="text-right">Median</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.returnsByYear)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([year, r]) => (
                      <tr key={year} className="border-t border-[var(--color-border)]">
                        <td>{year}</td>
                        <td className="text-right">{r.count}</td>
                        <td className="text-right">{fmtPct(r.meanReturn)}</td>
                        <td className="text-right">{fmtPct(r.medianReturn)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {result.trades.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-[var(--color-text-muted)]">Trades ({result.trades.length})</div>
              <div className="max-h-64 overflow-y-auto rounded border border-[var(--color-border)]">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[var(--color-surface)]">
                    <tr className="text-[var(--color-text-muted)]">
                      <th className="px-1.5 py-1 text-left">Entry</th>
                      <th className="px-1.5 py-1 text-left">Exit</th>
                      <th className="px-1.5 py-1 text-left">Reason</th>
                      <th className="px-1.5 py-1 text-right">Bars</th>
                      <th className="px-1.5 py-1 text-right">Return</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.trades.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--color-border)]">
                        <td className="px-1.5 py-1">{t.entryDate}</td>
                        <td className="px-1.5 py-1">{t.exitDate}</td>
                        <td className="px-1.5 py-1">{t.exitReason}</td>
                        <td className="px-1.5 py-1 text-right">{t.barsHeld}</td>
                        <td className={`px-1.5 py-1 text-right font-medium ${t.realizedReturn >= 0 ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}`}>
                          {fmtPct(t.realizedReturn)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
