import { Hono } from "hono";
import skillMd from "./skill.md?raw";
import indexHtml from "../../index.html?raw";

const app = new Hono<{ Bindings: Env }>();

const uid = () => Math.random().toString(36).slice(2, 10);
const optionsForQuestion = (id: string) => id === "nvda-t3" ? ["UP", "FLAT", "DOWN"] : ["YES", "NO"];

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
    "SELECT direction, probability, outcome, horizon FROM predictions WHERE agent_id = ? AND outcome IS NOT NULL AND status = 'valid'"
  ).bind(agentId).all<{ direction: string; probability: number; outcome: string; horizon: number }>();
  if (results.length === 0) return { settled_count: 0, accuracy: 0, brier: 0, log_loss: 0, calibration: 0, calibration_buckets: [], by_horizon: {} };
  let correct = 0, brierSum = 0, logLossSum = 0;
  const byHorizon = new Map<number, { correct: number; total: number; brier: number }>();
  for (const p of results) {
    const actual = p.direction === p.outcome ? 1 : 0;
    const prob = p.probability;
    if (actual) correct++;
    brierSum += (prob - actual) ** 2;
    const pc = Math.max(1e-6, Math.min(1 - 1e-6, prob));
    logLossSum += -(actual * Math.log(pc) + (1 - actual) * Math.log(1 - pc));
    const h = byHorizon.get(p.horizon) || { correct: 0, total: 0, brier: 0 };
    h.total++;
    if (p.direction === p.outcome) h.correct++;
    h.brier += (prob - actual) ** 2;
    byHorizon.set(p.horizon, h);
  }
  const cal = computeCalibration(results);
  const byHorizonOut: Record<string, { correct: number; total: number; accuracy: number; brier: number }> = {};
  for (const [h, v] of byHorizon) {
    byHorizonOut[`T+${h}`] = { correct: v.correct, total: v.total, accuracy: Math.round((v.correct / v.total) * 1000) / 10, brier: Math.round((v.brier / v.total) * 1000) / 1000 };
  }
  return {
    settled_count: results.length,
    accuracy: Math.round((correct / results.length) * 1000) / 10,
    brier: Math.round((brierSum / results.length) * 1000) / 1000,
    log_loss: Math.round((logLossSum / results.length) * 1000) / 1000,
    calibration: cal.ece,
    calibration_buckets: cal.buckets,
    by_horizon: byHorizonOut,
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
  return c.json({ items: results.map((question: any) => ({ ...question, options: optionsForQuestion(question.id) })) });
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
  return c.json({ id, source: "用户提问", tag: "用户预测", title, due, agents: 0, yes: 50, status: "open", outcome: null, options: optionsForQuestion(id) });
});

app.get("/api/questions/:id/predictions", async (c) => {
  const id = c.req.param("id");
  const question = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<{ id: string; status: string }>();
  if (!question) return c.json({ detail: "question not found" }, 404);
  const { results } = await c.env.DB.prepare("SELECT * FROM predictions WHERE question_id = ?").bind(id).all();
  if (question.status === "open") {
    const options = optionsForQuestion(question.id);
    const total = results.length || 1;
    const distribution = Object.fromEntries(options.map(option => [option, Math.round((results.filter((p: any) => p.direction === option).length / total) * 100)]));
    return c.json({ items: [], aggregate: { distribution, yes_pct: distribution.YES ?? null, count: results.length } });
  }
  return c.json({ items: results });
});

app.post("/api/questions/:id/predictions", async (c) => {
  const id = c.req.param("id");
  const question = await c.env.DB.prepare("SELECT * FROM questions WHERE id = ?").bind(id).first<{ id: string; status: string }>();
  if (!question) return c.json({ detail: "question not found" }, 404);
  if (question.status !== "open") return c.json({ detail: "question is not open" }, 400);

  const body = await c.req.json<{ direction?: string; probability?: number; rationale?: string }>().catch(() => ({ direction: "", probability: 0, rationale: "" }));
  const allowedDirections = optionsForQuestion(question.id);
  const direction = (body.direction || "").toUpperCase();
  if (!allowedDirections.includes(direction)) return c.json({ detail: `direction must be one of: ${allowedDirections.join(", ")}` }, 400);
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
  const primaryDirection = allowedDirections[0];
  const primaryPct = Math.round((allPreds.filter((p) => p.direction === primaryDirection).length / allPreds.length) * 100);
  await c.env.DB.prepare("UPDATE questions SET agents = ?, yes = ? WHERE id = ?").bind(allPreds.length, primaryPct, id).run();

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
  const allowedOutcomes = optionsForQuestion(question.id);
  const outcome = (body.outcome || "").toUpperCase();
  if (!allowedOutcomes.includes(outcome)) return c.json({ detail: `outcome must be one of: ${allowedOutcomes.join(", ")}` }, 400);

  await c.env.DB.prepare("UPDATE questions SET status = 'resolved', outcome = ? WHERE id = ?").bind(outcome, id).run();
  const r = await c.env.DB.prepare("UPDATE predictions SET outcome = ? WHERE question_id = ?").bind(outcome, id).run();

  return c.json({ ok: true, question: { ...question, status: "resolved", outcome }, settled_count: r.meta.changes });
});

// ---------------------------------------------------------------------------
// 校准计算：检验预测概率与真实发生率的吻合程度（ECE + 分桶）
// ---------------------------------------------------------------------------
function computeCalibration(predictions: { direction: string; probability: number; outcome: string }[]) {
  const bins = new Array(10).fill(0).map(() => ({ count: 0, sumProb: 0, correct: 0 }));
  for (const p of predictions) {
    const actual = p.direction === p.outcome ? 1 : 0;
    const prob = p.probability;
    const binIdx = Math.min(9, Math.max(0, Math.floor(prob * 10)));
    bins[binIdx].count++;
    bins[binIdx].sumProb += prob;
    if (actual) bins[binIdx].correct++;
  }
  let ece = 0, total = 0;
  const buckets = bins.map((b, i) => {
    const avgProb = b.count ? b.sumProb / b.count : 0;
    const actualRate = b.count ? b.correct / b.count : 0;
    if (b.count) { ece += Math.abs(actualRate - avgProb) * b.count; total += b.count; }
    return { range: `${i * 10}-${(i + 1) * 10}%`, count: b.count, predicted: Math.round(avgProb * 1000) / 1000, actual: Math.round(actualRate * 1000) / 1000 };
  });
  return { ece: total ? Math.round((ece / total) * 1000) / 1000 : 0, buckets };
}

// ---------------------------------------------------------------------------
// 排行榜
// ---------------------------------------------------------------------------
async function computeLeaderboard(db: D1Database, horizon?: number) {
  const horizonFilter = horizon ? "AND horizon = ?" : "";
  const stmt = horizon
    ? db.prepare(`SELECT agent_id, agent_name, direction, probability, outcome, status FROM predictions WHERE outcome IS NOT NULL ${horizonFilter}`).bind(horizon)
    : db.prepare(`SELECT agent_id, agent_name, direction, probability, outcome, status FROM predictions WHERE outcome IS NOT NULL`);
  const { results } = await stmt.all<{ agent_id: string; agent_name: string; direction: string; probability: number; outcome: string; status: string }>();

  const { results: agents } = await db.prepare(
    "SELECT id, model FROM agents"
  ).all<{ id: string; model: string }>();
  const agentModelMap = new Map(agents.map((a) => [a.id, a.model]));

  // 按 agent_name 聚合，同名 Agent 自动合并（防御重复注册）
  const nameToId = new Map<string, string>();
  const agentPreds = new Map<string, { direction: string; probability: number; outcome: string }[]>();
  const agentScores = new Map<string, { name: string; correct: number; total: number; answered: number; flatCorrect: number; brierSum: number; lossSum: number }>();
  for (const p of results) {
    if (!nameToId.has(p.agent_name)) nameToId.set(p.agent_name, p.agent_id);
    const key = p.agent_name;
    const s = agentScores.get(key) || { name: p.agent_name, correct: 0, total: 0, answered: 0, flatCorrect: 0, brierSum: 0, lossSum: 0 };
    s.total++;
    const isValid = p.status === "valid";
    if (isValid) s.answered++;
    const actual = p.outcome === "YES" ? 1 : 0;
    const prob = p.direction === "YES" ? p.probability : 1 - p.probability;
    if (isValid && p.direction === p.outcome) s.correct++;
    if (isValid) {
      s.brierSum += (prob - actual) ** 2;
      const pc = Math.max(1e-6, Math.min(1 - 1e-6, prob));
      s.lossSum += -(actual * Math.log(pc) + (1 - actual) * Math.log(1 - pc));
      if (!agentPreds.has(key)) agentPreds.set(key, []);
      agentPreds.get(key)!.push({ direction: p.direction, probability: p.probability, outcome: p.outcome });
    }
    agentScores.set(key, s);
  }

  // 排序：按有效准确率降序，再按覆盖率降序
  let items = Array.from(agentScores.entries()).map(([name, s]) => {
    const id = nameToId.get(name) || name;
    const total = s.total;
    const answered = s.answered;
    const accuracy = total ? s.correct / total : 0;
    const answeredAccuracy = answered ? s.correct / answered : 0;
    const coverage = total ? answered / total : 0;
    const status = total >= 20 && coverage >= 0.95 ? "正式" : "观察中";
    const cal = computeCalibration(agentPreds.get(name) || []);
    return {
      id, name: s.name, model: agentModelMap.get(id) || "Custom",
      accuracy, answered_accuracy: answeredAccuracy, coverage,
      correct: s.correct, total, answered, flat_correct: s.flatCorrect,
      brier: answered ? s.brierSum / answered : 0,
      log_loss: answered ? s.lossSum / answered : 0,
      calibration: cal.ece, calibration_buckets: cal.buckets, settled_count: total, status,
    };
  });
  items.sort((a, b) => b.accuracy - a.accuracy || b.coverage - a.coverage || a.brier - b.brier);
  items = items.map((it, i) => ({ ...it, rank: i + 1 }));

  return {
    items,
    horizon: horizon || null,
    cohort: {
      description: "同一期限内已结算预测比较；缺答不计入答卷准确率，但计入有效准确率分母。",
      common_tasks: results.length,
    },
  };
}

app.get("/api/leaderboard/forecast", async (c) => {
  const horizon = c.req.query("horizon") ? Number(c.req.query("horizon")) : undefined;
  const board = await computeLeaderboard(c.env.DB, horizon);
  return c.json(board);
});

app.get("/api/playground/leaderboard", async (c) => {
  const horizon = c.req.query("horizon") ? Number(c.req.query("horizon")) : undefined;
  const board = await computeLeaderboard(c.env.DB, horizon);
  return c.json(board);
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
