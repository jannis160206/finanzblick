import { ChartDataTable } from "@/components/chart-data-table";
import { currency } from "@/lib/format";
import type { AssistantChart } from "@/lib/types";

const fills = ["fill-primary/80", "fill-amber-500/80", "fill-sky-500/70"];
const strokes = ["stroke-primary", "stroke-amber-500", "stroke-sky-500"];
const swatches = ["bg-primary/80", "bg-amber-500/80", "bg-sky-500/70"];

// Compact SVG chart for chat answers; values come from code, the table below is the accessible alternative.
export function AssistantChartView({ chart, title }: { chart: AssistantChart; title: string }) {
  const width = 320;
  const height = 120;
  const top = 6;
  const bottom = 16;
  const labels = chart.series.reduce((longest, item) => item.points.length > longest.length ? item.points : longest, chart.series[0].points).map((point) => point.label);
  const values = [...chart.series.flatMap((item) => item.points.map((point) => point.value)), ...(chart.threshold ? [chart.threshold.value] : [])];
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const y = (value: number) => top + (max - value) / span * (height - top - bottom);
  const step = width / labels.length;
  const every = Math.max(1, Math.ceil(labels.length / 6));
  const last = chart.series.map((item) => item.points.at(-1));
  const summary = chart.series.map((item, index) => `${item.name}: zuletzt ${currency(last[index]?.value ?? 0)}`).join(", ");
  return <figure className="mt-3">
    <svg viewBox={`0 0 ${width} ${height}`} className="h-32 w-full" role="img" aria-label={`Diagramm ${title}. ${summary}.`}>
      <line x1="0" x2={width} y1={y(0)} y2={y(0)} className="stroke-border" strokeWidth="1" />
      {chart.threshold && <g>
        <line x1="0" x2={width} y1={y(chart.threshold.value)} y2={y(chart.threshold.value)} className="stroke-muted-foreground/70" strokeWidth="1" strokeDasharray="4 3" />
        <text x={width - 2} y={y(chart.threshold.value) - 3} textAnchor="end" className="fill-muted-foreground text-[9px]">{chart.threshold.label}</text>
      </g>}
      {chart.type === "bar" ? chart.series.map((item, series) => {
        const band = step * 0.7 / chart.series.length;
        return item.points.map((point, index) => <rect key={`${series}-${index}`} x={index * step + step * 0.15 + series * band} width={Math.max(1, band - 1)}
          y={Math.min(y(point.value), y(0))} height={Math.max(1, Math.abs(y(point.value) - y(0)))} rx="1.5"
          className={point.value < 0 ? "fill-red-500/80" : fills[series]}><title>{`${point.label} · ${item.name}: ${currency(point.value)}`}</title></rect>);
      }) : chart.series.map((item, series) => <g key={series}>
        <polyline fill="none" strokeWidth="2" strokeLinejoin="round" className={strokes[series]}
          points={item.points.map((point, index) => `${index * step + step / 2},${y(point.value)}`).join(" ")} />
        {item.points.map((point, index) => <circle key={index} cx={index * step + step / 2} cy={y(point.value)} r="2.5"
          className={point.value < (chart.threshold?.value ?? 0) ? "fill-red-500" : fills[series]}><title>{`${point.label} · ${item.name}: ${currency(point.value)}`}</title></circle>)}
      </g>)}
      {labels.map((label, index) => (index % every === 0 || index === labels.length - 1) &&
        <text key={index} x={index * step + step / 2} y={height - 3} textAnchor="middle" className="fill-muted-foreground text-[9px]">{label}</text>)}
    </svg>
    {(chart.series.length > 1 || chart.series[0].name) && <figcaption className="mt-1 flex flex-wrap gap-3 text-2xs text-muted-foreground">
      {chart.series.map((item, index) => <span key={item.name} className="inline-flex items-center gap-1"><span className={`size-2 rounded-sm ${swatches[index]}`} />{item.name}</span>)}
    </figcaption>}
    <ChartDataTable caption={title} columns={["", ...chart.series.map((item) => item.name)]}
      rows={labels.map((label, index) => ({ key: `${label}-${index}`, cells: [label, ...chart.series.map((item) => item.points[index] ? currency(item.points[index].value) : "–")] }))} />
  </figure>;
}
