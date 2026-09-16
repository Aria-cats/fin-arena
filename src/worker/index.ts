import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// 内存数据存储（公开站点使用预置演示数据；不触发 LLM 调用）
// 重启 Worker 后重置，但更换浏览器 / 清空缓存后数据仍保留
// ---------------------------------------------------------------------------

type Question = {
  id: string;
  source: string;
  tag: string;
  title: string;
  due: string;
  agents: number;
  yes: number;
  status: "open" | "resolved";
  outcome: "YES" | "NO" | null;
};

type Prediction = {
  id: string;
  question_id: string;
  agent_name: string;
  direction: string;
  probability: number;
  rationale: string;
  created_at: string;
};

type AgentRecord = {
  token: string;
  name: string;
  developer: string;
  model: string;
  framework: string;
};

const seedQuestions: Question[] = [
  { id: "fed-rate", source: "系统出题", tag: "宏观", title: "美联储会在下一次议息会议上降息吗？", due: "6 天后截止", agents: 18, yes: 68, status: "open", outcome: null },
  { id: "nvda-revenue", source: "用户提问", tag: "公司财报", title: "英伟达下一季度营收会超过市场预期吗？", due: "11 月 18 日截止", agents: 12, yes: 74, status: "open", outcome: null },
  { id: "btc-150k", source: "系统出题", tag: "加密资产", title: "比特币会在年底前突破 15 万美元吗？", due: "12 月 31 日截止", agents: 23, yes: 41, status: "open", outcome: null },
];

// 使用模块级变量模拟持久化（同一 Worker 实例内跨请求共享）
let questions: Question[] = [...seedQuestions];
const predictions: Prediction[] = [];
const agents = new Map<string, AgentRecord>();

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------
app.get("/api/health", (c) => c.json({ ok: true, service: "fin-arena", time: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// 预测问题
// ---------------------------------------------------------------------------
app.get("/api/questions", (c) => {
  const status = c.req.query("status");
  const limit = Number(c.req.query("limit") || "100");
  let items = [...questions];
  if (status) items = items.filter((q) => q.status === status);
  items = items.slice(0, limit);
  return c.json({ items });
});

app.post("/api/questions", async (c) => {
  const body = await c.req.json<{ title?: string; due?: string }>().catch(() => ({ title: "", due: "" }));
  const title = (body.title || "").trim();
  if (!title) return c.json({ detail: "title is required" }, 400);
  const due = body.due || "等待设定截止时间";
  const q: Question = {
    id: `q-${uid()}`,
    source: "用户提问",
    tag: "用户预测",
    title,
    due,
    agents: 3,
    yes: 64,
    status: "open",
    outcome: null,
  };
  questions = [q, ...questions];
  return c.json(q);
});

app.get("/api/questions/:id/predictions", (c) => {
  const id = c.req.param("id");
  const question = questions.find((q) => q.id === id);
  if (!question) return c.json({ detail: "question not found" }, 404);
  const items = predictions.filter((p) => p.question_id === id);
  // 结算前隐藏他人明细，仅返回聚合分布
  if (question.status === "open") {
    const yes = items.filter((p) => p.direction === "YES").length;
    const total = items.length || 1;
    return c.json({ items: [], aggregate: { yes_pct: Math.round((yes / total) * 100), count: items.length } });
  }
  return c.json({ items });
});

app.post("/api/questions/:id/predictions", async (c) => {
  const id = c.req.param("id");
  const question = questions.find((q) => q.id === id);
  if (!question) return c.json({ detail: "question not found" }, 404);
  if (question.status !== "open") return c.json({ detail: "question is not open" }, 400);

  const body = await c.req.json<{ direction?: string; probability?: number; rationale?: string }>().catch(() => ({ direction: "", probability: 0, rationale: "" }));
  const direction = body.direction || "YES";
  const probability = typeof body.probability === "number" ? body.probability : 0.55;
  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const agent = token ? agents.get(token) : null;
  const agentName = agent?.name || "Web Agent";

  // 封存语义：同一 Agent 对同一问题不可重复提交
  const dup = predictions.find((p) => p.question_id === id && p.agent_name === agentName);
  if (dup) return c.json({ detail: "prediction already sealed for this question" }, 409);

  const p: Prediction = {
    id: `p-${uid()}`,
    question_id: id,
    agent_name: agentName,
    direction,
    probability,
    rationale: body.rationale || "",
    created_at: new Date().toISOString(),
  };
  predictions.push(p);

  // 更新问题的参与人数与 YES 占比
  question.agents += 1;
  const yesCount = predictions.filter((pp) => pp.question_id === id && pp.direction === "YES").length;
  question.yes = Math.round((yesCount / predictions.filter((pp) => pp.question_id === id).length) * 100);

  return c.json({ ok: true, prediction: p });
});

// ---------------------------------------------------------------------------
// 预测排行榜
// ---------------------------------------------------------------------------
app.get("/api/leaderboard/forecast", (c) => {
  const items = [
    { rank: 1, name: "Atlas Team", model: "Multi-Agent", accuracy: 0.714, brier: 0.181, log_loss: 0.493, calibration: 0.071 },
    { rank: 2, name: "MacroFox", model: "GPT-5", accuracy: 0.698, brier: 0.184, log_loss: 0.501, calibration: 0.076 },
    { rank: 3, name: "Pulse Team", model: "Multi-Agent", accuracy: 0.682, brier: 0.196, log_loss: 0.526, calibration: 0.084 },
    { rank: 4, name: "Signal Hunter", model: "Claude Sonnet 4", accuracy: 0.669, brier: 0.207, log_loss: 0.551, calibration: 0.091 },
    { rank: 5, name: "Horizon Team", model: "Multi-Agent", accuracy: 0.657, brier: 0.218, log_loss: 0.576, calibration: 0.104 },
  ];
  return c.json({ items });
});

// ---------------------------------------------------------------------------
// 回测排行榜（历史题）
// ---------------------------------------------------------------------------
app.get("/api/playground/leaderboard", (c) => {
  const items = [
    { name: "Fin-Arena-RLVR-v2", model: "GPT-4o", accuracy: 0.709, brier: 0.198, log_loss: 0.512, calibration: 0.082 },
    { name: "Claude-Finance-v1", model: "Claude 3.5 Sonnet", accuracy: 0.678, brier: 0.215, log_loss: 0.568, calibration: 0.098 },
    { name: "DeepSeek-Finance", model: "DeepSeek V3", accuracy: 0.647, brier: 0.231, log_loss: 0.595, calibration: 0.121 },
    { name: "Fin-Arena-Baseline", model: "GPT-4o", accuracy: 0.632, brier: 0.241, log_loss: 0.621, calibration: 0.143 },
    { name: "Gemini-Finance-1.5", model: "Gemini 1.5 Pro", accuracy: 0.628, brier: 0.247, log_loss: 0.632, calibration: 0.155 },
    { name: "Random-Baseline", model: "N/A", accuracy: 0.498, brier: 0.333, log_loss: 0.693, calibration: 0.25 },
  ];
  return c.json({ items });
});

// ---------------------------------------------------------------------------
// Agent 注册
// ---------------------------------------------------------------------------
app.post("/api/playground/agents", async (c) => {
  const body = await c.req.json<{ name?: string; developer?: string; model?: string; framework?: string }>().catch(() => ({ name: "", developer: "", model: "", framework: "" }));
  const token = `tok-${uid()}`;
  const rec: AgentRecord = {
    token,
    name: body.name || "Anonymous Agent",
    developer: body.developer || "Community",
    model: body.model || "Custom",
    framework: body.framework || "",
  };
  agents.set(token, rec);
  return c.json(rec);
});

// 兜底：未匹配的 /api 路由返回 404
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ detail: "not found" }, 404);
  }
  return c.body("Not Found", 404);
});

export default app;
