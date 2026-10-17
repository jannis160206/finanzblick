import { FinancialData } from "@/components/financial-data";

export type ChartTable = {
  caption: string;
  columns: string[];
  rows: { key: string; cells: string[] }[];
};

// Gleichwertige Textalternative zu einem Diagramm; eingeklappt, damit die Seite ruhig bleibt.
export function ChartDataTable({ caption, columns, rows }: ChartTable) {
  return (
    <FinancialData as="section" className="mt-3">
      <details className="group text-xs">
        <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          Werte als Tabelle
        </summary>
        <div className="mt-2 max-h-64 overflow-auto rounded-lg border border-border/70" tabIndex={0} role="region" aria-label={`${caption} (Tabelle)`}>
          <table className="w-full border-collapse text-left tabular-nums">
            <caption className="sr-only">{caption}</caption>
            <thead className="bg-muted/40">
              <tr>
                {columns.map((column, index) => (
                  <th key={column} scope="col" className={index === 0 ? "px-3 py-2 font-medium" : "px-3 py-2 text-right font-medium"}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} className="border-t border-border/60">
                  {row.cells.map((cell, index) =>
                    index === 0 ? (
                      <th key={index} scope="row" className="px-3 py-2 font-normal">{cell}</th>
                    ) : (
                      <td key={index} className="px-3 py-2 text-right">{cell}</td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </FinancialData>
  );
}
