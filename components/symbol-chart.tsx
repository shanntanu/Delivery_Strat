"use client";

import { useMemo, useState } from "react";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceArea,
  CartesianGrid,
} from "recharts";
import type { ChartBar, PersistedSignalRow } from "../lib/queries/symbol-detail";

interface CandleShapeProps {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  payload?: { open: number | null; close: number | null; high: number | null; low: number | null };
}

function CandleShape(props: CandleShapeProps) {
  const { x, y, width, height, payload } = props;
  if (x === undefined || y === undefined || width === undefined || height === undefined || !payload) return null;
  const { open, close, high, low } = payload;
  if (open === null || close === null || high === null || low === null || high === low) return null;

  const isUp = close >= open;
  const color = isUp ? "#3fb950" : "#f85149";
  const pxPerUnit = height / (high - low);
  const bodyTop = y + (high - Math.max(open, close)) * pxPerUnit;
  const bodyBottom = y + (high - Math.min(open, close)) * pxPerUnit;
  const bodyHeight = Math.max(bodyBottom - bodyTop, 1);
  const wickX = x + width / 2;

  return (
    <g>
      <line x1={wickX} x2={wickX} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={x} y={bodyTop} width={width} height={bodyHeight} fill={color} />
    </g>
  );
}

export function SymbolChart({ bars, signals }: { bars: ChartBar[]; signals: PersistedSignalRow[] }) {
  const [highlighted, setHighlighted] = useState<PersistedSignalRow | null>(null);

  const priceData = useMemo(
    () =>
      bars.map((b) => ({
        date: b.date,
        highLow: b.high !== null && b.low !== null ? [b.low, b.high] : null,
        open: b.open,
        close: b.close,
        high: b.high,
        low: b.low,
      })),
    [bars]
  );

  const deliveryData = useMemo(() => {
    // 20-day rolling median baseline, matching the engine's own baseline
    // computation (excludes the day itself), just for the visual overlay.
    return bars.map((b, i) => {
      const start = i - 20;
      let baseline: number | null = null;
      if (start >= 0) {
        const window = bars.slice(start, i).map((x) => x.deliveryQty).filter((v): v is number => v !== null);
        if (window.length > 0) {
          const sorted = [...window].sort((a, c) => a - c);
          const mid = Math.floor(sorted.length / 2);
          baseline = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
        }
      }
      return { date: b.date, deliveryQty: b.deliveryQty, baseline };
    });
  }, [bars]);

  return (
    <div>
      <ResponsiveContainer width="100%" height={320}>
        <ComposedChart data={priceData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#232b36" />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#8b949e" }} minTickGap={40} />
          <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: "#8b949e" }} width={50} />
          <Tooltip
            contentStyle={{ background: "#121821", border: "1px solid #232b36", fontSize: 12 }}
            labelStyle={{ color: "#e6edf3" }}
          />
          {signals.map((s) => (
            <ReferenceArea
              key={s.id}
              x1={s.windowStart}
              x2={s.windowEnd}
              fill={highlighted?.id === s.id ? "#d29922" : "#3fb950"}
              fillOpacity={highlighted?.id === s.id ? 0.35 : 0.12}
              stroke="none"
            />
          ))}
          <Bar dataKey="highLow" shape={<CandleShape />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="mt-1 text-xs text-[var(--color-text-muted)]">Delivery quantity vs 20-day median baseline</div>
      <ResponsiveContainer width="100%" height={140}>
        <ComposedChart data={deliveryData} margin={{ top: 4, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#232b36" />
          <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#8b949e" }} minTickGap={40} />
          <YAxis tick={{ fontSize: 10, fill: "#8b949e" }} width={50} />
          <Tooltip contentStyle={{ background: "#121821", border: "1px solid #232b36", fontSize: 12 }} labelStyle={{ color: "#e6edf3" }} />
          <Bar dataKey="deliveryQty" fill="#58a6ff" isAnimationActive={false} />
          <Line dataKey="baseline" stroke="#d29922" dot={false} strokeWidth={1.5} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>

      <div className="mt-3 max-h-64 overflow-y-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-[var(--color-surface)]">
            <tr>
              {["Signal date", "Avg ratio", "Min ratio", "Trades ratio", "Price Δ", "Fwd 5d", "Fwd 10d", "Fwd 20d", "Realized"].map((h) => (
                <th key={h} className="whitespace-nowrap px-2 py-1.5 text-left font-medium text-[var(--color-text-muted)]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {signals.map((s) => (
              <tr
                key={s.id}
                onClick={() => setHighlighted(highlighted?.id === s.id ? null : s)}
                className={`cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-surface)] ${highlighted?.id === s.id ? "bg-[var(--color-amber)]/10" : ""}`}
              >
                <td className="whitespace-nowrap px-2 py-1.5">{s.signalDate}</td>
                <td className="px-2 py-1.5">{s.avgRatio?.toFixed(2) ?? "—"}</td>
                <td className="px-2 py-1.5">{s.minRatio?.toFixed(2) ?? "—"}</td>
                <td className="px-2 py-1.5">{s.tradesRatio?.toFixed(2) ?? "—"}</td>
                <td className="px-2 py-1.5">{s.priceChangePct !== null ? `${s.priceChangePct.toFixed(1)}%` : "—"}</td>
                <td className="px-2 py-1.5">{s.fwd5 !== null ? `${s.fwd5.toFixed(1)}%` : "—"}</td>
                <td className="px-2 py-1.5">{s.fwd10 !== null ? `${s.fwd10.toFixed(1)}%` : "—"}</td>
                <td className="px-2 py-1.5">{s.fwd20 !== null ? `${s.fwd20.toFixed(1)}%` : "—"}</td>
                <td className={`px-2 py-1.5 font-medium ${(s.realizedReturn ?? 0) >= 0 ? "text-[var(--color-green)]" : "text-[var(--color-red)]"}`}>
                  {s.realizedReturn !== null ? `${s.realizedReturn.toFixed(2)}%` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
