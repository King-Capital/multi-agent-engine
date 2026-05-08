import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

interface StatusSlice {
  name: string;
  value: number;
}

interface StatusPieChartProps {
  data: StatusSlice[];
  height?: number;
  title?: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: "#22d3ee",
  running: "#22d3ee",
  completed: "#10b981",
  done: "#10b981",
  failed: "#ef4444",
  error: "#ef4444",
  cancelled: "#f59e0b",
  blocked: "#f59e0b",
  idle: "#6b7280",
  pending: "#8b5cf6",
  waiting: "#8b5cf6",
};

const FALLBACK_COLORS = [
  "#22d3ee",
  "#10b981",
  "#ef4444",
  "#f59e0b",
  "#8b5cf6",
  "#6b7280",
];

function getColor(name: string, idx: number): string {
  return (
    STATUS_COLORS[name.toLowerCase()] ??
    FALLBACK_COLORS[idx % FALLBACK_COLORS.length]
  );
}

export function StatusPieChart({
  data,
  height = 240,
  title,
}: StatusPieChartProps) {
  const filtered = data.filter((d) => d.value > 0);

  if (!filtered.length) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground"
        style={{ height }}
      >
        {title ? `No ${title.toLowerCase()} data` : "No data"}
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={height}>
      <PieChart>
        <Pie
          data={filtered}
          dataKey="value"
          nameKey="name"
          cx="50%"
          cy="50%"
          outerRadius={80}
          innerRadius={45}
          paddingAngle={2}
          strokeWidth={0}
        >
          {filtered.map((entry, idx) => (
            <Cell key={entry.name} fill={getColor(entry.name, idx)} />
          ))}
        </Pie>
        <Tooltip
          contentStyle={{
            backgroundColor: "hsl(222.2 84% 5.9%)",
            border: "1px solid hsl(217.2 32.6% 17.5%)",
            borderRadius: 8,
            color: "hsl(210 40% 98%)",
            fontSize: 13,
          }}
        />
        <Legend
          wrapperStyle={{ fontSize: 12, color: "hsl(215 20.2% 65.1%)" }}
          formatter={(value: string) =>
            value.charAt(0).toUpperCase() + value.slice(1)
          }
        />
      </PieChart>
    </ResponsiveContainer>
  );
}
