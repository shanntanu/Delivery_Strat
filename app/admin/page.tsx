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
          <p className="mt-2 text-xs text-[var(--color-text-muted)]">
            This threshold is applied by <code>scripts/compute-liquid-universe.ts</code>, which reads the full local
            archive — the deployed app has no route to that data, so this panel is read-only here. To change it, run{" "}
            <code>npm run compute-universe -- --exchange NSE --min-turnover-cr &lt;value&gt;</code> locally.
          </p>
        </div>
      </section>

      <AdminPanel pendingActions={data.pendingActions} />

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Scan run history
        </h2>
        <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface)]">
              <tr>
                {["Started", "Finished", "Universe", "With signals", "Status"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium text-[var(--color-text-muted)]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.recentScanRuns.map((r) => (
                <tr key={r.id} className="border-t border-[var(--color-border)]">
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
