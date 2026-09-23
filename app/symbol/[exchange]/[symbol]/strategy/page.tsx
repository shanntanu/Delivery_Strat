import Link from "next/link";
import { notFound } from "next/navigation";
import { getStrategyEditorData } from "../../../../../lib/queries/strategy-editor";
import { StrategyEditor } from "../../../../../components/strategy-editor";

export const dynamic = "force-dynamic";

export default async function StrategyEditorPage({
  params,
}: {
  params: Promise<{ exchange: string; symbol: string }>;
}) {
  const { exchange, symbol } = await params;
  const upperExchange = exchange.toUpperCase();
  const upperSymbol = symbol.toUpperCase();
  const data = await getStrategyEditorData(upperExchange, upperSymbol);

  if (data.notFound) notFound();

  const isCustomActive = JSON.stringify(data.startingParams) !== JSON.stringify(data.defaultParams);

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/symbol/${upperExchange}/${upperSymbol}`} className="text-sm text-[var(--color-text-muted)] hover:underline">
          ← {upperSymbol}
        </Link>
      </div>
      <h1 className="text-lg font-semibold">Strategy editor — {upperSymbol}</h1>

      {data.history.length > 1 && (
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-muted)]">
          {data.history.length} saved strategies for this symbol (including default). History is append-only.
        </div>
      )}

      <StrategyEditor
        exchange={upperExchange}
        symbol={upperSymbol}
        defaultParams={data.defaultParams}
        startingParams={data.startingParams}
        isCustomActive={isCustomActive}
      />
    </div>
  );
}
