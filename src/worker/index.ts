import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import skillMd from "./skill.md?raw";
import indexHtml from "../../index.html?raw";

const app = new Hono<{ Bindings: Env }>();

const uid = () => Math.random().toString(36).slice(2, 10);
const optionsForQuestion = (id: string) => id === "nvda-t3" ? ["UP", "FLAT", "DOWN"] : ["YES", "NO"];
const nowIso = () => new Date().toISOString();
const secureToken = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
const hashToken = async (token: string) => {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};
const jsonError = (c: any, status: number, code: string, message: string) => c.json({ error: { code, message } }, status);
const sessionAgent = async (c: any) => {
  const raw = getCookie(c, "pronoia_session");
  if (!raw) return null;
  const hash = await hashToken(raw);
  return c.env.DB.prepare(`SELECT a.agent_id,a.name,a.developer,a.model,a.framework,a.created_at
    FROM browser_sessions s JOIN future_agents a ON a.agent_id=s.agent_id
    WHERE s.session_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`).bind(hash, nowIso()).first();
};

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
// Real future forecast API (isolated from historical playground data)
// ---------------------------------------------------------------------------
app.get("/api/future/questions", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT q.*,
    (SELECT COUNT(*) FROM forecast_submissions s WHERE s.question_id=q.question_id) AS agent_count
    FROM future_questions q ORDER BY q.created_at DESC`).all();
  return c.json({ items: results.map((q: any) => ({ ...q, rules: JSON.parse(q.rules_json), rules_json: undefined })) });
});

app.get("/api/future/questions/:id", async (c) => {
  const q = await c.env.DB.prepare(`SELECT q.*,
    (SELECT COUNT(*) FROM forecast_submissions s WHERE s.question_id=q.question_id) AS agent_count
    FROM future_questions q WHERE q.question_id=?`).bind(c.req.param("id")).first<any>();
  if (!q) return jsonError(c, 404, "QUESTION_NOT_FOUND", "赛题不存在");
  return c.json({ ...q, rules: JSON.parse(q.rules_json), rules_json: undefined });
});

app.post("/api/future/agents", async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const name = String(body.name || "").trim();
  const developer = String(body.developer || "").trim();
  const model = String(body.model || "").trim();
  const framework = String(body.framework || "").trim();
  if (!name || !developer || !model || !framework) return jsonError(c, 400, "INVALID_AGENT", "名称、开发者、模型和框架均为必填项");
  const agentId = `agent_${crypto.randomUUID()}`;
  const token = secureToken("pronoia");
  const createdAt = nowIso();
  await c.env.DB.prepare(`INSERT INTO future_agents(agent_id,name,developer,model,framework,token_hash,created_at)
    VALUES(?,?,?,?,?,?,?)`).bind(agentId, name, developer, model, framework, await hashToken(token), createdAt).run();
  return c.json({ agent_id: agentId, name, developer, model, framework, created_at: createdAt, agent_token: token }, 201);
});

app.post("/api/future/questions/:id/submissions", async (c) => {
  const questionId = c.req.param("id");
  const auth = c.req.header("Authorization") || "";
  const rawToken = auth.replace(/^Bearer\s+/i, "");
  if (!rawToken) return jsonError(c, 401, "INVALID_AGENT_TOKEN", "缺少 Agent token");
  const agent = await c.env.DB.prepare("SELECT agent_id,name FROM future_agents WHERE token_hash=?").bind(await hashToken(rawToken)).first<any>();
  if (!agent) return jsonError(c, 401, "INVALID_AGENT_TOKEN", "Agent token 无效");
  const question = await c.env.DB.prepare("SELECT * FROM future_questions WHERE question_id=?").bind(questionId).first<any>();
  if (!question) return jsonError(c, 404, "QUESTION_NOT_FOUND", "赛题不存在");
  if (question.status !== "open" || Date.parse(question.closes_at) <= Date.now()) return jsonError(c, 409, "QUESTION_CLOSED", "赛题已截止，无法提交");
  const body = await c.req.json<any>().catch(() => ({}));
  const probabilities = [body.probability_up, body.probability_flat, body.probability_down];
  if (probabilities.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1)) return jsonError(c, 400, "INVALID_PROBABILITY", "UP、FLAT、DOWN 概率必须是 0 到 1 之间的数字");
  const sum = probabilities.reduce((a: number, b: number) => a + b, 0);
  if (Math.abs(sum - 1) > 1e-6) return jsonError(c, 400, "INVALID_PROBABILITY_SUM", "UP、FLAT、DOWN 三项概率总和必须为 1");
  const duplicate = await c.env.DB.prepare("SELECT submission_id FROM forecast_submissions WHERE agent_id=? AND question_id=?").bind(agent.agent_id, questionId).first();
  if (duplicate) return jsonError(c, 409, "ALREADY_SUBMITTED", "该 Agent 已提交过本题，封存后不可修改");
  const submissionId = `sub_${crypto.randomUUID()}`;
  const bindingToken = secureToken("bind");
  const submittedAt = nowIso();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO forecast_submissions(submission_id,agent_id,question_id,probability_up,probability_flat,probability_down,rationale,submitted_at,sealed)
      VALUES(?,?,?,?,?,?,?,?,1)`).bind(submissionId, agent.agent_id, questionId, body.probability_up, body.probability_flat, body.probability_down, String(body.rationale || "").slice(0, 1000), submittedAt),
    c.env.DB.prepare(`INSERT INTO browser_binding_tokens(token_hash,agent_id,submission_id,expires_at,created_at) VALUES(?,?,?,?,?)`)
      .bind(await hashToken(bindingToken), agent.agent_id, submissionId, expiresAt, submittedAt)
  ]);
  const bindingUrl = `${new URL(c.req.url).origin}/#/bind/${encodeURIComponent(bindingToken)}`;
  return c.json({ agent_name: agent.name, submission_id: submissionId, probability_up: body.probability_up, probability_flat: body.probability_flat, probability_down: body.probability_down, status: "sealed", submitted_at: submittedAt, binding_url: bindingUrl }, 201);
});

app.get("/api/future/submissions/:id", async (c) => {
  const item = await c.env.DB.prepare(`SELECT s.*,a.name AS agent_name,a.model,a.framework,q.title AS question_title,q.status AS question_status
    FROM forecast_submissions s JOIN future_agents a ON a.agent_id=s.agent_id JOIN future_questions q ON q.question_id=s.question_id
    WHERE s.submission_id=?`).bind(c.req.param("id")).first();
  if (!item) return jsonError(c, 404, "SUBMISSION_NOT_FOUND", "封存记录不存在");
  return c.json(item);
});

app.post("/api/future/bind/:token", async (c) => {
  const tokenHash = await hashToken(c.req.param("token"));
  const binding = await c.env.DB.prepare("SELECT * FROM browser_binding_tokens WHERE token_hash=?").bind(tokenHash).first<any>();
  if (!binding) return jsonError(c, 404, "BINDING_NOT_FOUND", "绑定链接无效");
  if (binding.used_at) return jsonError(c, 409, "BINDING_USED", "绑定链接已经使用过");
  if (Date.parse(binding.expires_at) <= Date.now()) return jsonError(c, 410, "BINDING_EXPIRED", "绑定链接已过期，请让 Agent 重新生成");
  const rawSession = secureToken("session");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const used = await c.env.DB.prepare("UPDATE browser_binding_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL").bind(createdAt, tokenHash).run();
  if (!used.meta.changes) return jsonError(c, 409, "BINDING_USED", "绑定链接已经使用过");
  await c.env.DB.prepare("INSERT INTO browser_sessions(session_hash,agent_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await hashToken(rawSession), binding.agent_id, expiresAt, createdAt).run();
  setCookie(c, "pronoia_session", rawSession, { httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", path: "/", maxAge: 30 * 24 * 60 * 60 });
  return c.json({ ok: true, submission_id: binding.submission_id });
});

app.get("/api/future/me", async (c) => {
  const agent = await sessionAgent(c) as any;
  if (!agent) return jsonError(c, 401, "NOT_BOUND", "当前浏览器尚未绑定 Agent");
  const { results } = await c.env.DB.prepare(`SELECT s.*,q.title AS question_title,q.status AS question_status
    FROM forecast_submissions s JOIN future_questions q ON q.question_id=s.question_id
    WHERE s.agent_id=? ORDER BY s.submitted_at DESC`).bind(agent.agent_id).all();
  return c.json({ agent, submissions: results });
});

app.post("/api/future/logout", async (c) => {
  const raw = getCookie(c, "pronoia_session");
  if (raw) await c.env.DB.prepare("UPDATE browser_sessions SET revoked_at=? WHERE session_hash=?").bind(nowIso(), await hashToken(raw)).run();
  deleteCookie(c, "pronoia_session", { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/future/questions/:id/submissions", async (c) => {
  const question = await c.env.DB.prepare("SELECT question_id,status FROM future_questions WHERE question_id=?").bind(c.req.param("id")).first<any>();
  if (!question) return jsonError(c, 404, "QUESTION_NOT_FOUND", "赛题不存在");
  const { results } = await c.env.DB.prepare(`SELECT s.submission_id,s.probability_up,s.probability_flat,s.probability_down,s.rationale,s.submitted_at,s.sealed,s.settlement_result,s.score,
    a.agent_id,a.name AS agent_name,a.developer,a.model,a.framework
    FROM forecast_submissions s JOIN future_agents a ON a.agent_id=s.agent_id WHERE s.question_id=? ORDER BY s.submitted_at ASC`).bind(c.req.param("id")).all();
  return c.json({ items: results, settled: question.status === "settled" });
});

app.get("/api/future/questions/:id/leaderboard", async (c) => {
  const question = await c.env.DB.prepare("SELECT status,outcome FROM future_questions WHERE question_id=?").bind(c.req.param("id")).first<any>();
  if (!question) return jsonError(c, 404, "QUESTION_NOT_FOUND", "赛题不存在");
  if (question.status !== "settled") return c.json({ settled: false, outcome: null, items: [] });
  const { results } = await c.env.DB.prepare(`SELECT s.submission_id,s.score,s.settlement_result,s.probability_up,s.probability_flat,s.probability_down,a.name AS agent_name,a.model
    FROM forecast_submissions s JOIN future_agents a ON a.agent_id=s.agent_id WHERE s.question_id=? ORDER BY s.score DESC,s.submitted_at ASC`).bind(c.req.param("id")).all();
  return c.json({ settled: true, outcome: question.outcome, items: results.map((item: any, index) => ({ rank: index + 1, ...item })) });
});

app.post("/api/admin/future/questions/:id/settle", async (c) => {
  const configured = (c.env as any).ADMIN_TOKEN as string | undefined;
  if (!configured || c.req.header("X-Admin-Token") !== configured) return jsonError(c, 401, "ADMIN_UNAUTHORIZED", "管理员凭证无效");
  const body = await c.req.json<any>().catch(() => ({}));
  const outcome = String(body.outcome || "").toUpperCase();
  if (!["UP", "FLAT", "DOWN"].includes(outcome)) return jsonError(c, 400, "INVALID_OUTCOME", "结果必须是 UP、FLAT 或 DOWN");
  const question = await c.env.DB.prepare("SELECT * FROM future_questions WHERE question_id=?").bind(c.req.param("id")).first<any>();
  if (!question) return jsonError(c, 404, "QUESTION_NOT_FOUND", "赛题不存在");
  if (question.status === "settled") return jsonError(c, 409, "ALREADY_SETTLED", "赛题已经结算");
  const { results } = await c.env.DB.prepare("SELECT * FROM forecast_submissions WHERE question_id=?").bind(c.req.param("id")).all<any>();
  const statements = results.map((s) => {
    const targets = [outcome === "UP" ? 1 : 0, outcome === "FLAT" ? 1 : 0, outcome === "DOWN" ? 1 : 0];
    const probs = [s.probability_up, s.probability_flat, s.probability_down];
    const brier = probs.reduce((sum: number, p: number, i: number) => sum + (p - targets[i]) ** 2, 0) / 2;
    const score = Math.round((1 - brier) * 10000) / 100;
    return c.env.DB.prepare("UPDATE forecast_submissions SET settlement_result=?,score=? WHERE submission_id=?").bind(outcome, score, s.submission_id);
  });
  const settledAt = nowIso();
  statements.push(c.env.DB.prepare("UPDATE future_questions SET status='settled',outcome=? WHERE question_id=?").bind(outcome, c.req.param("id")));
  statements.push(c.env.DB.prepare("INSERT INTO settlements(settlement_id,question_id,outcome,settled_at) VALUES(?,?,?,?)").bind(`settle_${crypto.randomUUID()}`, c.req.param("id"), outcome, settledAt));
  await c.env.DB.batch(statements);
  return c.json({ ok: true, outcome, settled_at: settledAt, submission_count: results.length });
});

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
