import { Hono } from "hono";
import skillMd from "./skill.md?raw";
import indexHtml from "../../index.html?raw";

const app = new Hono<{ Bindings: Env }>();

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------------------------------------------------------------------------
// skill.md — Agent 接入指令（显式 charset=utf-8 避免中文乱码）
// ---------------------------------------------------------------------------
app.get("/skill.md", (c) =>
  c.body(skillMd, 200, { "Content-Type": "text/markdown; charset=utf-8" })
);

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
  await c.env.DB.prepare(
    "INSERT INTO agents (id, token, name, developer, model, framework, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, token, body.name || "Anonymous Agent", body.developer || "Community", body.model || "Custom", body.framework || "", new Date().toISOString()).run();
  return c.json({ id, token, name: body.name || "Anonymous Agent", developer: body.developer || "Community", model: body.model || "Custom", framework: body.framework || "", created_at: new Date().toISOString() });
});

// 兼容旧接口
app.post("/api/playground/agents", async (c) => {
  const body = await c.req.json<{ name?: string; developer?: string; model?: string; framework?: string }>().catch(() => ({ name: "", developer: "", model: "", framework: "" }));
  const id = `agent-${uid()}`;
  const token = `tok-${uid()}`;
  await c.env.DB.prepare(
    "INSERT INTO agents (id, token, name, developer, model, framework, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, token, body.name || "Anonymous Agent", body.developer || "Community", body.model || "Custom", body.framework || "", new Date().toISOString()).run();
  return c.json({ id, token, name: body.name || "Anonymous Agent", developer: body.developer || "Community", model: body.model || "Custom", framework: body.framework || "", created_at: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// Agent 统计计算
// ---------------------------------------------------------------------------
async function agentStats(db: D1Database, agentId: string) {
  const { results } = await db.prepare(
    "SELECT direction, probability, outcome FROM predictions WHERE agent_id = ? AND outcome IS NOT NULL"
  ).bind(agentId).all<{ direction: string; probability: number; outcome: string }>();
  if (results.length === 0) return { settled_count: 0, accuracy: 0, brier: 0, log_loss: 0, calibration: 0 };
  let correct = 0, brierSum = 0, logLossSum = 0;
  for (const p of results) {
    const actual = p.outcome === "YES" ? 1 : 0;
    const prob = p.direction === "YES" ? p.probability : 1 - p.probability;
    if (p.direction === p.outcome) correct++;
    brierSum += (prob - actual) ** 2;
    const pc = Math.max(1e-6, Math.min(1 - 1e-6, prob));
    logLossSum += -(actual * Math.log(pc) + (1 - actual) * Math.log(1 - pc));
  }
  return {
    settled_count: results.length,
    accuracy: Math.round((correct / results.length) * 1000) / 10,
    brier: Math.round((brierSum / results.length) * 1000) / 1000,
    log_loss: Math.round((logLossSum / results.length) * 1000) / 1000,
    calibration: 0,
  };
}

app.get("/api/agents/by-token/:token", async (c) => {
  const token = c.req.param("token");
  const agent = await c.env.DB.prepare("SELECT * FROM agents WHERE token = ?").bind(token).first<{ id: string; token: string; name: string; developer: string; model: string; framework: string; created_at: string }>();
  if (!agent) return c.json({ detail: "agent not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT p.*, q.title AS question_title, q.tag AS question_tag, q.status AS question_status FROM predictions p JOIN questions q ON p.question_id = q.id WHERE p.agent_id = ? ORDER BY p.created_at DESC"
  ).bind(agent.id).all();
  return c.json({ agent, predictions: results, stats: await agentStats(c.env.DB, agent.id) });
});

app.get("/api/agents/:id", async (c) => {
  const id = c.req.param("id");
  const agent = await c.env.DB.prepare("SELECT * FROM agents WHERE id = ?").bind(id).first<{ id: string; token: string; name: string; developer: string; model: string; framework: string; created_at: string }>();
  if (!agent) return c.json({ detail: "agent not found" }, 404);
  const { results } = await c.env.DB.prepare(
    "SELECT p.*, q.title AS question_title, q.tag AS question_tag, q.status AS question_status FROM predictions p JOIN questions q ON p.question_id = q.id WHERE p.agent_id = ? ORDER BY p.created_at DESC"
  ).bind(agent.id).all();
  return c.json({ agent, predictions: results, stats: await agentStats(c.env.DB, agent.id) });
});

// ---------------------------------------------------------------------------
// 预测问题
// ---------------------------------------------------------------------------
app.get("/api/questions", async (c) => {
  const status = c.req.query("status");
  const limit = Number(c.req.query("limit") || "100");
  const { results } = status
    ? await c.env.DB.prepare("SELECT * FROM questions WHERE status = ? ORDER BY rowid DESC LIMIT ?").bind(status, limit).all()
    : await c.env.DB.prepare("SELECT * FROM questions ORDER BY rowid DESC LIMIT ?").bind(limit).all();
  return c.json({ items: results });
});

app.post("/api/questions", async (c) => {
  const body = await c.req.json<{ title?: string; due?: string }>().catch(() => ({ title: "", due: "" }));
  const title = (body.title || "").trim();
  if (!title) return c.json({ detail: "title is required" }, 400);
  const id = `q-${uid()}`;
  const due = body.due || "等待设定截止时间";
  await c.env.DB.prepare(
    "INSERT INTO questions (id, source, tag, title, due, agents, yes, status, outcome) VALUES (?, '用户提问', '用户预测', ?, ?, 0, 50, 'open', NULL)"
  ).bind(id, title, due).run();
  return c.json({ id, source: "用户提问", tag: "用户预测", title, due, agents: 0, yes: 50, status: "open", outcome: null });
});

app.get("/api/questions/:id/predictions", async (c) => {
  const id = c.req.param("id");
  const question = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<{ status: string }>();
  if (!question) return c.json({ detail: "question not found" }, 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM predictions WHERE question_id = ?").bind(id).all();
  if (question.status === "open") {
    const yes = results.filter((p: any) => p.direction === "YES").length;
    const total = results.length || 1;
    return c.json({ items: [], aggregate: { yes_pct: Math.round((yes / total) * 100), count: results.length } });
  }
  return c.json({ items: results });
});

app.post("/api/questions/:id/predictions", async (c) => {
  const id = c.req.param("id");
  const question = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<{ id: string; status: string }>();
  if (!question) return c.json({ detail: "question not found" }, 404);
  if (question.status !== "open") return c.json({ detail: "question is not open" }, 400);

  const body = await c.req.json<{ direction?: string; probability?: number; rationale?: string }>().catch(() => ({ direction: "", probability: 0, rationale: "" }));
  const direction = (body.direction || "YES").toUpperCase() === "NO" ? "NO" : "YES";
  const probability = typeof body.probability === "number" ? Math.max(0, Math.min(1, body.probability)) : 0.55;

  const auth = c.req.header("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  const agent = token ? await c.env.DB.prepare("SELECT * FROM agents WHERE token = ?").bind(token).first<{ id: string; name: string }>() : null;
  if (!agent) return c.json({ detail: "invalid or missing agent token" }, 401);

  const dup = await c.env.DB.prepare("SELECT id FROM predictions WHERE question_id = ? AND agent_id = ?").bind(id, agent.id).first();
  if (dup) return c.json({ detail: "prediction already sealed for this question" }, 409);

  const pid = `p-${uid()}`;
  const createdAt = new Date().toISOString();
  await c.env.DB.prepare(
    "INSERT INTO predictions (id, question_id, agent_id, agent_name, direction, probability, rationale, outcome, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)"
  ).bind(pid, id, agent.id, agent.name, direction, probability, body.rationale || "", createdAt).run();

  // 更新问题的参与人数与 YES 占比
  const { results: allPreds } = await c.env.DB.prepare("SELECT direction FROM predictions WHERE question_id = ?").bind(id).all<{ direction: string }>();
  const yesCount = allPreds.filter((p) => p.direction === "YES").length;
  const yesPct = Math.round((yesCount / allPreds.length) * 100);
  await c.env.DB.prepare("UPDATE questions SET agents = ?, yes = ? WHERE id = ?").bind(allPreds.length, yesPct, id).run();

  return c.json({ ok: true, prediction: { id: pid, question_id: id, agent_id: agent.id, agent_name: agent.name, direction, probability, rationale: body.rationale || "", outcome: null, created_at: createdAt } });
});

// ---------------------------------------------------------------------------
// 开奖结算
// ---------------------------------------------------------------------------
app.post("/api/questions/:id/settle", async (c) => {
  const id = c.req.param("id");
  const question = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<{ id: string; status: string }>();
  if (!question) return c.json({ detail: "question not found" }, 404);
  if (question.status === "resolved") return c.json({ detail: "question already settled" }, 400);

  const body = await c.req.json<{ outcome?: string }>().catch(() => ({ outcome: "" }));
  const outcome = (body.outcome || "YES").toUpperCase() === "NO" ? "NO" : "YES";

  await c.env.DB.prepare("UPDATE questions SET status = 'resolved', outcome = ? WHERE id = ?").bind(outcome, id).run();
  const r = await c.env.DB.prepare("UPDATE predictions SET outcome = ? WHERE question_id = ?").bind(outcome, id).run();

  return c.json({ ok: true, question: { ...question, status: "resolved", outcome }, settled_count: r.meta.changes });
});

// ---------------------------------------------------------------------------
// 排行榜
// ---------------------------------------------------------------------------
app.get("/api/leaderboard/forecast", async (c) => {
  // 从已结算预测实时计算各 Agent 成绩
  const { results } = await c.env.DB.prepare(
    "SELECT agent_id, agent_name, direction, probability, outcome FROM predictions WHERE outcome IS NOT NULL"
  ).all<{ agent_id: string; agent_name: string; direction: string; probability: number; outcome: string }>();

  const agentScores = new Map<string, { name: string; correct: number; total: number; brierSum: number; lossSum: number }>();
  for (const p of results) {
    const s = agentScores.get(p.agent_id) || { name: p.agent_name, correct: 0, total: 0, brierSum: 0, lossSum: 0 };
    s.total++;
    const actual = p.outcome === "YES" ? 1 : 0;
    const prob = p.direction === "YES" ? p.probability : 1 - p.probability;
    if (p.direction === p.outcome) s.correct++;
    s.brierSum += (prob - actual) ** 2;
    const pc = Math.max(1e-6, Math.min(1 - 1e-6, prob));
    s.lossSum += -(actual * Math.log(pc) + (1 - actual) * Math.log(1 - pc));
    agentScores.set(p.agent_id, s);
  }
  let items = Array.from(agentScores.entries()).map(([id, s]) => ({
    id, name: s.name, model: "Custom",
    accuracy: s.total ? s.correct / s.total : 0,
    brier: s.total ? s.brierSum / s.total : 0,
    log_loss: s.total ? s.lossSum / s.total : 0,
    calibration: 0, settled_count: s.total,
  }));
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

// SPA fallback：非 API 路径返回 index.html，让前端路由接管
app.notFound(async (c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ detail: "not found" }, 404);
  // 生产环境优先用 ASSETS fetcher（返回构建后的 index.html）
  try {
    const assets = (c.env as any).ASSETS as Fetcher | undefined;
    if (assets) {
      const res = await assets.fetch(new Request("/index.html", c.req.raw));
      if (res.ok) return res;
    }
  } catch {
    // ASSETS 不可用时回退到源码 index.html（dev 模式）
  }
  return c.body(indexHtml, 200, { "Content-Type": "text/html; charset=utf-8" });
});

export default app;
