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
  agent_id: string;
  agent_name: string;
  direction: "YES" | "NO";
  probability: number;
  rationale: string;
  outcome: "YES" | "NO" | null;
  created_at: string;
};

type AgentRecord = {
  id: string;
  token: string;
  name: string;
  developer: string;
  model: string;
  framework: string;
  created_at: string;
};

const seedQuestions: Question[] = [
  { id: "nvda-t3", source: "系统出题", tag: "公司财报", title: "三天后，英伟达(NVDA)会涨、会跌，还是原地不动？", due: "T+3 截止", agents: 4, yes: 62, status: "open", outcome: null },
  { id: "fed-rate", source: "系统出题", tag: "宏观", title: "美联储会在下一次议息会议上降息吗？", due: "6 天后截止", agents: 18, yes: 68, status: "open", outcome: null },
  { id: "btc-150k", source: "系统出题", tag: "加密资产", title: "比特币会在年底前突破 15 万美元吗？", due: "12 月 31 日截止", agents: 23, yes: 41, status: "open", outcome: null },
];

let questions: Question[] = [...seedQuestions];
const predictions: Prediction[] = [];
const agents = new Map<string, AgentRecord>(); // token -> AgentRecord
const agentById = new Map<string, AgentRecord>();

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// 健康检查
// ---------------------------------------------------------------------------
app.get("/api/health", (c) => c.json({ ok: true, service: "fin-arena", time: new Date().toISOString() }));

// ---------------------------------------------------------------------------
// Agent 注册
// ---------------------------------------------------------------------------
app.post("/api/agents", async (c) => {
  const body = await c.req.json<{ name?: string; developer?: string; model?: string; framework?: string }>().catch(() => ({ name: "", developer: "", model: "", framework: "" }));
  const id = `agent-${uid()}`;
  const token = `tok-${uid()}`;
  const rec: AgentRecord = {
    id,
    token,
    name: body.name || "Anonymous Agent",
    developer: body.developer || "Community",
    model: body.model || "Custom",
    framework: body.framework || "",
    created_at: new Date().toISOString(),
  };
  agents.set(token, rec);
  agentById.set(id, rec);
  return c.json(rec);
});

// 兼容旧接口
app.post("/api/playground/agents", async (c) => {
  const body = await c.req.json<{ name?: string; developer?: string; model?: string; framework?: string }>().catch(() => ({ name: "", developer: "", model: "", framework: "" }));
  const id = `agent-${uid()}`;
  const token = `tok-${uid()}`;
  const rec: AgentRecord = {
    id, token,
    name: body.name || "Anonymous Agent",
    developer: body.developer || "Community",
    model: body.model || "Custom",
    framework: body.framework || "",
    created_at: new Date().toISOString(),
  };
  agents.set(token, rec);
  agentById.set(id, rec);
  return c.json(rec);
});

// ---------------------------------------------------------------------------
// Agent 详情 + 预测 + 统计
// ---------------------------------------------------------------------------
function agentStats(agentId: string) {
  const mine = predictions.filter((p) => p.agent_id === agentId);
  const settled = mine.filter((p) => p.outcome !== null);
  if (settled.length === 0) {
    return { settled_count: 0, accuracy: 0, brier: 0, log_loss: 0, calibration: 0 };
  }
  let correct = 0;
  let brierSum = 0;
  let logLossSum = 0;
  for (const p of settled) {
    const actual = p.outcome === "YES" ? 1 : 0;
    const prob = p.direction === "YES" ? p.probability : 1 - p.probability;
    if ((p.direction === "YES" && p.outcome === "YES") || (p.direction === "NO" && p.outcome === "NO")) correct++;
    brierSum += (prob - actual) ** 2;
    const pClipped = Math.max(1e-6, Math.min(1 - 1e-6, prob));
    logLossSum += -(actual * Math.log(pClipped) + (1 - actual) * Math.log(1 - pClipped));
  }
  return {
    settled_count: settled.length,
    accuracy: Math.round((correct / settled.length) * 1000) / 10,
    brier: Math.round((brierSum / settled.length) * 1000) / 1000,
    log_loss: Math.round((logLossSum / settled.length) * 1000) / 1000,
    calibration: 0,
  };
}

app.get("/api/agents/by-token/:token", (c) => {
  const token = c.req.param("token");
  const agent = agents.get(token);
  if (!agent) return c.json({ detail: "agent not found" }, 404);
  const preds = predictions.filter((p) => p.agent_id === agent.id).map((p) => {
    const q = questions.find((qq) => qq.id === p.question_id);
    return {
      ...p,
      question_title: q?.title || "",
      question_tag: q?.tag || "",
      question_status: q?.status || "open",
    };
  });
  return c.json({ agent, predictions: preds, stats: agentStats(agent.id) });
});

app.get("/api/agents/:id", (c) => {
  const id = c.req.param("id");
  const agent = agentById.get(id) || Array.from(agents.values()).find((a) => a.id === id);
  if (!agent) return c.json({ detail: "agent not found" }, 404);
  const preds = predictions.filter((p) => p.agent_id === agent.id).map((p) => {
    const q = questions.find((qq) => qq.id === p.question_id);
    return { ...p, question_title: q?.title || "", question_tag: q?.tag || "", question_status: q?.status || "open" };
  });
  return c.json({ agent, predictions: preds, stats: agentStats(agent.id) });
});

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
    title, due,
    agents: 0, yes: 50,
    status: "open", outcome: null,
  };
  questions = [q, ...questions];
  return c.json(q);
});

app.get("/api/questions/:id/predictions", (c) => {
  const id = c.req.param("id");
  const question = questions.find((q) => q.id === id);
  if (!question) return c.json({ detail: "question not found" }, 404);
  const items = predictions.filter((p) => p.question_id === id);
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
  const direction = (body.direction || "YES").toUpperCase() === "NO" ? "NO" : "YES";
  const probability = typeof body.probability === "number" ? Math.max(0, Math.min(1, body.probability)) : 0.55;

  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const agent = token ? agents.get(token) : null;
  if (!agent) return c.json({ detail: "invalid or missing agent token" }, 401);

  const dup = predictions.find((p) => p.question_id === id && p.agent_id === agent.id);
  if (dup) return c.json({ detail: "prediction already sealed for this question" }, 409);

  const p: Prediction = {
    id: `p-${uid()}`,
    question_id: id,
    agent_id: agent.id,
    agent_name: agent.name,
    direction,
    probability,
    rationale: body.rationale || "",
    outcome: null,
    created_at: new Date().toISOString(),
  };
  predictions.push(p);

  question.agents += 1;
  const qPreds = predictions.filter((pp) => pp.question_id === id);
  const yesCount = qPreds.filter((pp) => pp.direction === "YES").length;
  question.yes = Math.round((yesCount / qPreds.length) * 100);

  return c.json({ ok: true, prediction: p });
});

// ---------------------------------------------------------------------------
// 开奖结算
// ---------------------------------------------------------------------------
app.post("/api/questions/:id/settle", async (c) => {
  const id = c.req.param("id");
  const question = questions.find((q) => q.id === id);
  if (!question) return c.json({ detail: "question not found" }, 404);
  if (question.status === "resolved") return c.json({ detail: "question already settled" }, 400);

  const body = await c.req.json<{ outcome?: string }>().catch(() => ({ outcome: "" }));
  const outcome = (body.outcome || "YES").toUpperCase() === "NO" ? "NO" : "YES";

  question.status = "resolved";
  question.outcome = outcome;

  // 回写结果到每条预测
  for (const p of predictions) {
    if (p.question_id === id) p.outcome = outcome;
  }

  const settledPreds = predictions.filter((p) => p.question_id === id);
  return c.json({ ok: true, question, settled_count: settledPreds.length });
});

// ---------------------------------------------------------------------------
// 排行榜
// ---------------------------------------------------------------------------
app.get("/api/leaderboard/forecast", (c) => {
  // 从已结算预测实时计算各 Agent 成绩
  const agentScores = new Map<string, { name: string; model: string; correct: number; total: number; brierSum: number; lossSum: number }>();
  for (const p of predictions) {
    if (p.outcome === null) continue;
    const s = agentScores.get(p.agent_id) || { name: p.agent_name, model: "Custom", correct: 0, total: 0, brierSum: 0, lossSum: 0 };
    s.total++;
    const actual = p.outcome === "YES" ? 1 : 0;
    const prob = p.direction === "YES" ? p.probability : 1 - p.probability;
    if ((p.direction === "YES" && p.outcome === "YES") || (p.direction === "NO" && p.outcome === "NO")) s.correct++;
    s.brierSum += (prob - actual) ** 2;
    const pc = Math.max(1e-6, Math.min(1 - 1e-6, prob));
    s.lossSum += -(actual * Math.log(pc) + (1 - actual) * Math.log(1 - pc));
    agentScores.set(p.agent_id, s);
  }
  let items = Array.from(agentScores.entries()).map(([id, s]) => ({
    id, name: s.name, model: s.model,
    accuracy: s.total ? s.correct / s.total : 0,
    brier: s.total ? s.brierSum / s.total : 0,
    log_loss: s.total ? s.lossSum / s.total : 0,
    calibration: 0,
    settled_count: s.total,
  }));
  // 如果没有真实结算数据，返回预置演示榜
  if (items.length === 0) {
    items = [
      { id: "demo-1", name: "Atlas Team", model: "Multi-Agent", accuracy: 0.714, brier: 0.181, log_loss: 0.493, calibration: 0.071, settled_count: 14 },
      { id: "demo-2", name: "MacroFox", model: "GPT-5", accuracy: 0.698, brier: 0.184, log_loss: 0.501, calibration: 0.076, settled_count: 12 },
      { id: "demo-3", name: "Pulse Team", model: "Multi-Agent", accuracy: 0.682, brier: 0.196, log_loss: 0.526, calibration: 0.084, settled_count: 11 },
    ];
  }
  items.sort((a, b) => b.accuracy - a.accuracy || a.brier - b.brier);
  items = items.map((it, i) => ({ ...it, rank: i + 1 }));
  return c.json({ items });
});

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

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json({ detail: "not found" }, 404);
  }
  return c.body("Not Found", 404);
});

export default app;
