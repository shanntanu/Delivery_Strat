import { getAdminData } from "../../lib/queries/admin";
import { AdminPanel } from "../../components/admin-panel";

export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string }) {
  const color =
    status === "success" || status === "completed"
      ? "text-[var(--color-green)] border-[var(--color-green)]/40"
      : status === "no_data"
        ? "text-[var(--color-grey)] border-[var(--color-grey)]/40"
        : status === "running"
          ? "text-[var(--color-amber)] border-[var(--color-amber)]/40"
          : "text-[var(--color-red)] border-[var(--color-red)]/40";
  return <span className={`rounded-full border px-2 py-0.5 text-xs ${color}`}>{status}</span>;
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
}

// Liquidity composition drifts slowly (new listings, delisting, turnover
// regime changes) — CLAUDE.md doesn't set a cadence for
// compute-liquid-universe.ts, since it can only ever run manually against
// the local archive (see README.md). 30 days is a judgment call, not a
// derived number: frequent enough to catch drift, infrequent enough that
// forgetting for a week or two isn't a crisis.
const UNIVERSE_STALE_DAYS = 30;

function UniverseStalenessBanner({ lastComputedAt }: { lastComputedAt: string | null }) {
  const days = daysSince(lastComputedAt);
  if (days === null) {
    return (
      <div className="mt-2 rounded border border-[var(--color-red)]/40 bg-[var(--color-red)]/10 px-3 py-2 text-xs">
        Never computed against this database. Run <code>npm run compute-universe -- --exchange NSE</code> locally —
        until then, is_scan_universe reflects whatever backfill/migration originally set it, not a real liquidity check.
      </div>
    );
  }
  const stale = days > UNIVERSE_STALE_DAYS;
  return (
    <div
      className={`mt-2 rounded border px-3 py-2 text-xs ${
        stale ? "border-[var(--color-amber)]/40 bg-[var(--color-amber)]/10" : "border-[var(--color-border)]"
      }`}
    >
      Last computed {days} day{days === 1 ? "" : "s"} ago.
      {stale && ` Past the ${UNIVERSE_STALE_DAYS}-day guideline — newly-liquid symbols may be missing and delisted/illiquid ones may still be scanned. Re-run compute-universe when convenient.`}
    </div>
  );
}

export default async function AdminPage() {
  const data = await getAdminData();

  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">Admin</h1>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Universe filter settings
        </h2>
        <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-sm">
          <div>
            Liquidity threshold: <strong>₹{data.liquidityThresholdCr}cr</strong> 20-day median turnover (CLAUDE.md §4.3 default)
          </div>
          <div>
            Current NSE scan universe: <strong>{data.universeSize}</strong> symbols
          </div>
          <div>
            Tuner: <strong>{data.symbolsTuned}</strong> tuned, <strong>{data.symbolsNoReliablePattern}</strong> no
            reliable pattern, <strong>{data.universeSize - data.symbolsTuned - data.symbolsNoReliablePattern}</strong> not
            yet tuned
          </div>
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            This threshold is applied by <code>scripts/compute-liquid-universe.ts</code>, which reads the full local
            archive — the deployed app has no route to that data, so this panel is read-only here. To change it, run{" "}
            <code>npm run compute-universe -- --exchange NSE --min-turnover-cr &lt;value&gt;</code> locally.
          </p>
          <UniverseStalenessBanner lastComputedAt={data.universeLastComputedAt} />
        </div>
      </section>

      <AdminPanel pendingActions={data.pendingActions} />

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Run history (scan / tune / universe recompute)
        </h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface)]">
              <tr>
                {["Type", "Started", "Finished", "Universe", "With signals / tuned", "Status"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-[var(--color-text-muted)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recentRuns.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2 font-medium">{r.runType}</td>
                  <td className="px-3 py-2">{r.startedAt}</td>
                  <td className="px-3 py-2">{r.finishedAt ?? "—"}</td>
                  <td className="px-3 py-2">{r.universeSize ?? "—"}</td>
                  <td className="px-3 py-2">{r.symbolsWithSignals ?? "—"}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Ingestion status (last 30 dates)
        </h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface)]">
              <tr>
                {["Exchange", "Date", "Status", "Rows", "Error"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-[var(--color-text-muted)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recentIngestion.map((r) => (
                <tr key={`${r.exchange}-${r.date}`} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2">{r.exchange}</td>
                  <td className="px-3 py-2">{r.date}</td>
                  <td className="px-3 py-2">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-2">{r.rowsIngested ?? "—"}</td>
                  <td className="max-w-xs truncate px-3 py-2 text-xs text-[var(--color-red)]" title={r.error ?? undefined}>
                    {r.error ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
