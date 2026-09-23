import { getDashboardRows } from "../lib/queries/dashboard";
import { DashboardTable } from "../components/dashboard-table";

export const dynamic = "force-dynamic";

function HeaderStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

export default async function DashboardPage() {
  const { rows, header } = await getDashboardRows("NSE");

  return (
    <div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <HeaderStat label="Last ingestion" value={header.lastIngestionDate ?? "—"} />
        <HeaderStat label="Universe size" value={String(header.universeSize)} />
        <HeaderStat label="Active signals today" value={String(header.symbolsWithActiveSignalsToday)} />
        <HeaderStat
          label="Last scan"
          value={header.lastScanStatus ? `${header.lastScanStatus}` : "never run"}
        />
      </div>

      <div className="mb-4 rounded-lg border border-[var(--color-amber)]/30 bg-[var(--color-amber)]/10 px-4 py-3 text-sm">
        This tool measures a historical tendency on a small sample per symbol. It is not an
        advisory product, does not place orders, and does not predict. Reliability badges marked
        with * reflect signal count only — see CLAUDE.md §2.4.
      </div>

      <DashboardTable rows={rows} />
    </div>
  );
}
