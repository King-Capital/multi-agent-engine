import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { formatCurrency } from "@/lib/utils";

interface CostAreaChartProps {
  data: Array<{ day: string; cost: number }>;
  height?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tooltipFormatter = (value: unknown) =>
  [formatCurrency(Number(value ?? 0)), "Cost"] as [string, string];

const labelFormatter = (label: unknown) => {
  const d = new Date(String(label) + "T00:00:00");
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
};

export function CostAreaChart({ data, height = 300 }: CostAreaChartProps) {
  if (!data.length) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground"
        style={{ height }}
      >
        No cost data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="costGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#22d3ee" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(217.2 32.6% 17.5%)" />
        <XAxis
          dataKey="day"
          stroke="hsl(215 20.2% 65.1%)"
          fontSize={12}
          tickFormatter={(v: string) => {
            const d = new Date(v + "T00:00:00");
            return d.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            });
          }}
        />
        <YAxis
          stroke="hsl(215 20.2% 65.1%)"
          fontSize={12}
          tickFormatter={(v: number) => `$${v.toFixed(2)}`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(222.2 84% 5.9%)",
            border: "1px solid hsl(217.2 32.6% 17.5%)",
            borderRadius: 8,
            color: "hsl(210 40% 98%)",
            fontSize: 13,
          }}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          formatter={tooltipFormatter as any}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          labelFormatter={labelFormatter as any}
        />
        <Area
          type="monotone"
          dataKey="cost"
          stroke="#22d3ee"
          strokeWidth={2}
          fill="url(#costGradient)"
          dot={false}
          activeDot={{ r: 4, fill: "#22d3ee", stroke: "#0e7490" }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
