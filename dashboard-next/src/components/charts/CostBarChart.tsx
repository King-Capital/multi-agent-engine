import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import type { TooltipContentProps } from "recharts";
import { formatCurrency } from "@/lib/utils";

interface ChainCostData {
  chain: string;
  cost: number;
  sessions: number;
}

interface CostBarChartProps {
  data: ChainCostData[];
  height?: number;
}

const BAR_COLORS = ["#22d3ee", "#06b6d4", "#0891b2", "#0e7490", "#155e75"];

function ChartTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        backgroundColor: "hsl(222.2 84% 5.9%)",
        border: "1px solid hsl(217.2 32.6% 17.5%)",
        borderRadius: 8,
        color: "hsl(210 40% 98%)",
        fontSize: 13,
        padding: "8px 12px",
      }}
    >
      <p>Cost: {formatCurrency(Number(payload[0].value ?? 0))}</p>
    </div>
  );
}

export function CostBarChart({ data, height = 260 }: CostBarChartProps) {
  if (!data.length) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground"
        style={{ height }}
      >
        No chain cost data
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 24, left: 8, bottom: 4 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="hsl(217.2 32.6% 17.5%)"
          horizontal={false}
        />
        <XAxis
          type="number"
          stroke="hsl(215 20.2% 65.1%)"
          fontSize={12}
          tickFormatter={(v: number) => `$${v.toFixed(2)}`}
        />
        <YAxis
          type="category"
          dataKey="chain"
          stroke="hsl(215 20.2% 65.1%)"
          fontSize={12}
          width={120}
          tickFormatter={(v: string) =>
            v.length > 18 ? v.slice(0, 16) + "…" : v
          }
        />
        <Tooltip content={(props) => <ChartTooltip {...props} />} />
        <Bar dataKey="cost" radius={[0, 4, 4, 0]} barSize={24}>
          {data.map((_entry, idx) => (
            <Cell key={idx} fill={BAR_COLORS[idx % BAR_COLORS.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
