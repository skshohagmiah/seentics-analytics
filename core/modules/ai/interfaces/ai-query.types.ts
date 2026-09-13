export type AIVizType = "table" | "bar_chart" | "line_chart" | "pie_chart" | "number";

export type AIDomain =
  | "analytics"
  | "revenue"
  | "replays"
  | "heatmaps"
  | "funnels"
  | "automations";

export interface AIHistoryItem {
  id: string;
  prompt: string;
  title: string | null;
  viz_type: string | null;
  status: string;
  created_at: string;
}

export interface AIResponse {
  sql: string;
  viz_type: AIVizType;
  title: string;
  insight: string;
  tips: string | string[];
  x_key: string | null;
  y_key: string | null;
  columns: Array<{ key: string; label: string }>;
}

export interface AIQueryResult {
  rows: Record<string, unknown>[];
  viz_type: AIVizType;
  title: string;
  insight: string | null;
  tips: string | null;
  x_key: string | null;
  y_key: string | null;
  columns: Array<{ key: string; label: string }>;
  sql: string;
  execution_time_ms: number;
  tokens: { input: number; output: number };
  estimated_cost_usd: number;
}
