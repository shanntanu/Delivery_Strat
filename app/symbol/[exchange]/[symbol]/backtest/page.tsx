import Link from "next/link";
import { notFound } from "next/navigation";
import { getBacktestPageData } from "../../../../../lib/queries/backtest";
import { BacktestPanel } from "../../../../../components/backtest-panel";

export const dynamic = "force-dynamic";

export default async function BacktestPage({
  params,
}: {
  params: Promise<{ exchange: string; symbol: string }>;
}) {
  const { exchange, symbol } = await params;
  const upperExchange = exchange.toUpperCase();
  const upperSymbol = symbol.toUpperCase();
  const data = await getBacktestPageData(upperExchange, upperSymbol);

  if (data.notFound || !data.dataFrom || !data.dataTo) notFound();

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/symbol/${upperExchange}/${upperSymbol}`} className="text-sm text-[var(--color-text-muted)] hover:underline">
          ← {upperSymbol}
        </Link>
      </div>
      <h1 className="text-lg font-semibold">Backtest — {upperSymbol}</h1>
      <div className="rounded-lg border border-[var(--color-amber)]/30 bg-[var(--color-amber)]/10 px-4 py-3 text-sm">
        Costs (brokerage, slippage, STT) are always applied, per CLAUDE.md §10.4 — there is no cost-free toggle.
        Compare two strategies or two date ranges side by side.
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BacktestPanel
          exchange={upperExchange}
          symbol={upperSymbol}
          strategyOptions={data.strategyOptions}
          dataFrom={data.dataFrom}
          dataTo={data.dataTo}
          label="Strategy A"
        />
        <BacktestPanel
          exchange={upperExchange}
          symbol={upperSymbol}
          strategyOptions={data.strategyOptions}
          dataFrom={data.dataFrom}
          dataTo={data.dataTo}
          label="Strategy B"
        />
      </div>
    </div>
  );
}
