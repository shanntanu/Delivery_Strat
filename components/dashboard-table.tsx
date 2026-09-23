"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  type ColumnDef,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import type { DashboardRow } from "../lib/queries/dashboard";

const BADGE_RANK: Record<DashboardRow["badge"], number> = { green: 0, amber: 1, grey: 2 };
const BADGE_COLOR: Record<DashboardRow["badge"], string> = {
  green: "bg-[var(--color-green)]/20 text-[var(--color-green)] border-[var(--color-green)]/40",
  amber: "bg-[var(--color-amber)]/20 text-[var(--color-amber)] border-[var(--color-amber)]/40",
  grey: "bg-[var(--color-grey)]/20 text-[var(--color-grey)] border-[var(--color-grey)]/40",
};

const STATUS_LABEL: Record<DashboardRow["status"], string> = {
  active_signal: "Active signal",
  in_trade: "In trade",
  watching: "Watching",
  no_pattern: "No pattern",
};

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function DashboardTable({ rows }: { rows: DashboardRow[] }) {
  const [hideNoPattern, setHideNoPattern] = useState(true);
  const [sorting, setSorting] = useState<SortingState>([{ id: "badgeRank", desc: false }]);

  const visibleRows = useMemo(
    () => (hideNoPattern ? rows.filter((r) => r.status !== "no_pattern") : rows),
    [rows, hideNoPattern]
  );

  const columns = useMemo<ColumnDef<DashboardRow>[]>(
    () => [
      {
        header: "Symbol",
        accessorKey: "symbol",
        cell: ({ row }) => (
          <Link
            href={`/symbol/${row.original.exchange}/${row.original.symbol}`}
            className="font-medium text-[var(--color-text)] hover:underline"
          >
            {row.original.symbol}
          </Link>
        ),
      },
      {
        header: "Name",
        accessorKey: "name",
        cell: ({ getValue }) => <span className="text-[var(--color-text-muted)]">{(getValue() as string) ?? "—"}</span>,
      },
      { header: "Exchange", accessorKey: "exchange" },
      {
        header: "Signals",
        accessorKey: "signalCount",
      },
      {
        header: "Median 10d return",
        accessorKey: "medianReturn",
        cell: ({ getValue }) => fmtPct(getValue() as number | null),
      },
      {
        header: "Win rate",
        accessorKey: "winRate",
        cell: ({ getValue }) => {
          const v = getValue() as number | null;
          return v === null ? "—" : `${v.toFixed(0)}%`;
        },
      },
      {
        header: "Status",
        accessorKey: "status",
        cell: ({ getValue }) => STATUS_LABEL[getValue() as DashboardRow["status"]],
      },
      {
        id: "badgeRank",
        header: "Reliability",
        accessorFn: (row) => BADGE_RANK[row.badge],
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${BADGE_COLOR[row.original.badge]}`}
            title={
              row.original.badgeIsPartial
                ? "Based on signal count only — p-value and out-of-sample check require running the tuner, not yet done for this symbol."
                : "Signal count, permutation p-value, and out-of-sample agreement all considered."
            }
          >
            {row.original.badge}
            {row.original.badgeIsPartial && <span className="opacity-60">*</span>}
          </span>
        ),
      },
    ],
    []
  );

  const table = useReactTable({
    data: visibleRows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <label className="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <input
            type="checkbox"
            checked={hideNoPattern}
            onChange={(e) => setHideNoPattern(e.target.checked)}
            className="h-4 w-4 rounded border-[var(--color-border)]"
          />
          Hide &quot;no pattern&quot; symbols
        </label>
        <span className="text-sm text-[var(--color-text-muted)]">
          {visibleRows.length} of {rows.length} symbols shown
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface)]">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => (
                  <th
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className="cursor-pointer select-none whitespace-nowrap px-3 py-2 text-left font-medium text-[var(--color-text-muted)]"
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: " ▲", desc: " ▼" }[header.column.getIsSorted() as string] ?? ""}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => (
              <tr key={row.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface)]">
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="whitespace-nowrap px-3 py-2">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-xs text-[var(--color-text-muted)]">
        * Reliability badge based on signal count only for symbols the tuner hasn&apos;t processed yet — see tooltip.
      </p>
    </div>
  );
}
