"""Persistence for the public forecast arena: questions, sealed predictions, leaderboard.

设计（P0-2 预测对局）：
  - forecast_questions: 公共预测池的问题（open / resolved）
  - forecast_predictions: Agent 封存预测（提交后不可改，UNIQUE(question_id, agent_id)）
  - 结算后回填 is_correct，未来预测总榜只统计已揭晓问题
"""
from __future__ import annotations

import math
from typing import Any

from . import db


def init_forecast_tables() -> None:
    with db._lock:
        conn = db._get_conn()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS forecast_questions(
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL UNIQUE,
                tag TEXT NOT NULL DEFAULT '综合',
                source TEXT NOT NULL DEFAULT '用户提问',
                due TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'open',
                outcome TEXT,
                created_at TEXT NOT NULL,
                resolved_at TEXT
            );
            CREATE TABLE IF NOT EXISTS forecast_predictions(
                id TEXT PRIMARY KEY,
                question_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                agent_name TEXT NOT NULL,
                agent_model TEXT NOT NULL DEFAULT '',
                direction TEXT NOT NULL,
                probability REAL NOT NULL,
                rationale TEXT,
                is_correct INTEGER,
                created_at TEXT NOT NULL,
                UNIQUE(question_id, agent_id),
                FOREIGN KEY(question_id) REFERENCES forecast_questions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_fpred_question ON forecast_predictions(question_id);
            CREATE INDEX IF NOT EXISTS idx_fpred_agent ON forecast_predictions(agent_id);
            """
        )
        conn.commit()
    _seed_demo_data()


# ------------------------------------------------------------------ questions ----

_AGGREGATE_SQL = """
    SELECT q.id, q.title, q.tag, q.source, q.due, q.status, q.outcome,
           q.created_at, q.resolved_at,
           COUNT(p.id) AS agents,
           AVG(CASE WHEN p.direction='YES' THEN p.probability ELSE 1-p.probability END) AS yes_pct
    FROM forecast_questions q
    LEFT JOIN forecast_predictions p ON p.question_id = q.id
"""


def _row_to_question(row: Any) -> dict[str, Any]:
    d = dict(row)
    d["agents"] = int(d.get("agents") or 0)
    yes = d.get("yes_pct")
    d["yes"] = int(round(yes * 100)) if yes is not None else 50
    d.pop("yes_pct", None)
    return d


def list_questions(*, status: str | None = None, limit: int = 50, offset: int = 0) -> tuple[int, list[dict[str, Any]]]:
    where, args = "", []
    if status and status != "all":
        where = "WHERE q.status=?"
        args.append(status)
    with db._lock:
        conn = db._get_conn()
        total = conn.execute(f"SELECT COUNT(*) c FROM forecast_questions q {where}", tuple(args)).fetchone()["c"]
        rows = conn.execute(
            f"{_AGGREGATE_SQL} {where} GROUP BY q.id ORDER BY q.created_at DESC LIMIT ? OFFSET ?",
            tuple(args + [int(limit), int(offset)]),
        ).fetchall()
    return int(total), [_row_to_question(r) for r in rows]


def get_question(question_id: str) -> dict[str, Any] | None:
    with db._lock:
        row = db._get_conn().execute(
            f"{_AGGREGATE_SQL} WHERE q.id=? GROUP BY q.id", (question_id,)
        ).fetchone()
    return _row_to_question(row) if row else None


def get_question_by_title(title: str) -> dict[str, Any] | None:
    with db._lock:
        row = db._get_conn().execute(
            f"{_AGGREGATE_SQL} WHERE q.title=? GROUP BY q.id", (title.strip(),)
        ).fetchone()
    return _row_to_question(row) if row else None


def create_question(*, title: str, tag: str = "用户预测", source: str = "用户提问", due: str = "") -> dict[str, Any]:
    title = title.strip()
    existing = get_question_by_title(title)
    if existing:
        return existing
    qid, ts = "q_" + db.new_id(), db.now_iso()
    with db._lock:
        conn = db._get_conn()
        conn.execute(
            "INSERT INTO forecast_questions(id,title,tag,source,due,status,outcome,created_at,resolved_at)"
            " VALUES(?,?,?,?,?,'open',NULL,?,NULL)",
            (qid, title, tag.strip() or "综合", source.strip() or "用户提问", due.strip(), ts),
        )
        conn.commit()
    return get_question(qid) or {"id": qid, "title": title, "status": "open"}


# --------------------------------------------------------------- predictions ----

def add_prediction(
    *,
    question_id: str,
    agent_id: str,
    agent_name: str,
    agent_model: str = "",
    direction: str,
    probability: float,
    rationale: str = "",
) -> dict[str, Any]:
    """封存一条预测。异常：not_found / closed / duplicate。"""
    question = get_question(question_id)
    if not question:
        raise KeyError("question not found")
    if question["status"] != "open":
        raise PermissionError("question already resolved")
    with db._lock:
        conn = db._get_conn()
        dup = conn.execute(
            "SELECT id FROM forecast_predictions WHERE question_id=? AND agent_id=?",
            (question_id, agent_id),
        ).fetchone()
        if dup:
            raise ValueError("prediction already sealed for this question")
        pid, ts = "fp_" + db.new_id(), db.now_iso()
        conn.execute(
            "INSERT INTO forecast_predictions(id,question_id,agent_id,agent_name,agent_model,"
            "direction,probability,rationale,is_correct,created_at) VALUES(?,?,?,?,?,?,?,?,NULL,?)",
            (pid, question_id, agent_id, agent_name.strip() or agent_id, agent_model.strip(),
             direction, float(probability), rationale.strip() or None, ts),
        )
        conn.commit()
    return {"id": pid, "question_id": question_id, "agent_id": agent_id,
            "agent_name": agent_name, "direction": direction, "probability": probability,
            "created_at": ts, "sealed": True}


def list_predictions(question_id: str) -> list[dict[str, Any]]:
    with db._lock:
        rows = db._get_conn().execute(
            "SELECT id,question_id,agent_id,agent_name,agent_model,direction,probability,"
            "rationale,is_correct,created_at FROM forecast_predictions WHERE question_id=?"
            " ORDER BY created_at ASC",
            (question_id,),
        ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["is_correct"] = bool(d["is_correct"]) if d.get("is_correct") is not None else None
        out.append(d)
    return out


def distribution(question_id: str) -> dict[str, Any]:
    """结算前的聚合视图：只暴露分布，不暴露单个 Agent 的原始概率。"""
    preds = list_predictions(question_id)
    if not preds:
        return {"agents": 0, "yes": 50, "yes_votes": 0, "no_votes": 0}
    yes_votes = sum(1 for p in preds if p["direction"] == "YES")
    p_yes = [p["probability"] if p["direction"] == "YES" else 1 - p["probability"] for p in preds]
    return {
        "agents": len(preds),
        "yes": int(round(sum(p_yes) / len(preds) * 100)),
        "yes_votes": yes_votes,
        "no_votes": len(preds) - yes_votes,
    }


# ------------------------------------------------------------------ settlement ----

def settle_question(question_id: str, outcome: str) -> dict[str, Any]:
    """人工录入结算结果（YES/NO），回填每条预测的 is_correct。"""
    question = get_question(question_id)
    if not question:
        raise KeyError("question not found")
    if question["status"] != "open":
        raise PermissionError("question already resolved")
    ts = db.now_iso()
    with db._lock:
        conn = db._get_conn()
        conn.execute(
            "UPDATE forecast_questions SET status='resolved', outcome=?, resolved_at=? WHERE id=?",
            (outcome, ts, question_id),
        )
        conn.execute(
            "UPDATE forecast_predictions SET is_correct=(direction=?) WHERE question_id=?",
            (outcome, question_id),
        )
        conn.commit()
    return get_question(question_id) or {}


# ---------------------------------------------------------------- leaderboard ----

def forecast_leaderboard(limit: int = 50) -> list[dict[str, Any]]:
    """未来预测总榜：只统计已揭晓问题，按 Brier 升序（概率质量）排名。"""
    with db._lock:
        rows = db._get_conn().execute(
            "SELECT p.agent_id, p.agent_name, p.agent_model, p.direction, p.probability,"
            "p.is_correct, q.outcome FROM forecast_predictions p"
            " JOIN forecast_questions q ON q.id = p.question_id"
            " WHERE q.status='resolved'"
        ).fetchall()
    stats: dict[str, dict[str, Any]] = {}
    for r in rows:
        y = 1.0 if r["outcome"] == "YES" else 0.0
        p_yes = r["probability"] if r["direction"] == "YES" else 1 - r["probability"]
        p_yes = min(max(p_yes, 1e-6), 1 - 1e-6)
        p_actual = p_yes if y else 1 - p_yes
        hit = int(r["direction"] == r["outcome"])
        s = stats.setdefault(
            r["agent_id"],
            {"agent_id": r["agent_id"], "name": r["agent_name"], "model": r["agent_model"] or "Custom",
             "n": 0, "correct": 0, "briers": [], "losses": [], "calib": []},
        )
        s["n"] += 1
        s["correct"] += hit
        s["briers"].append((p_yes - y) ** 2)
        s["losses"].append(-math.log(max(p_actual, 1e-9)))
        s["calib"].append((r["probability"], hit))
    items = []
    for s in stats.values():
        n = s["n"]
        # ECE：5 个置信度桶
        ece = 0.0
        for low in (0.0, 0.2, 0.4, 0.6, 0.8):
            bucket = [x for x in s["calib"] if low <= x[0] < low + 0.2 or (low == 0.8 and x[0] == 1.0)]
            if bucket:
                ece += len(bucket) / n * abs(sum(x[0] for x in bucket) / len(bucket) - sum(x[1] for x in bucket) / len(bucket))
        items.append({
            "agent_id": s["agent_id"], "name": s["name"], "model": s["model"],
            "predictions": n, "correct": s["correct"],
            "accuracy": round(s["correct"] / n, 4),
            "brier": round(sum(s["briers"]) / n, 4),
            "log_loss": round(sum(s["losses"]) / n, 4),
            "calibration": round(ece, 4),
        })
    items.sort(key=lambda x: (x["brier"], -x["accuracy"]))
    return items[: int(limit)]


# ---------------------------------------------------------------------- seed ----

_DEMO_AGENTS = [
    ("Pronoia", "GLM-5.3"), ("Fin-Arena-RLVR-v2", "GPT-4o"),
    ("Claude-Finance-v1", "Claude 3.5 Sonnet"), ("DeepSeek-Finance", "DeepSeek V3"),
    ("Gemini-Finance-1.5", "Gemini 1.5 Pro"), ("MacroFox", "GPT-5"),
    ("Signal Hunter", "Claude Sonnet 4"), ("Atlas Team", "Multi-Agent"),
    ("Pulse Team", "Multi-Agent"), ("Horizon Team", "Multi-Agent"),
    ("Quant-Sparrow", "DeepSeek V3"), ("Nova-Quant", "GPT-4o mini"),
]

_SEED_QUESTIONS = [
    {"id": "fed-rate", "title": "美联储会在下一次议息会议上降息吗？", "tag": "宏观",
     "source": "系统出题", "due": "6 天后截止", "agents": 18, "yes": 68},
    {"id": "nvda-revenue", "title": "英伟达下一季度营收会超过市场预期吗？", "tag": "公司财报",
     "source": "用户提问", "due": "11 月 18 日截止", "agents": 12, "yes": 74},
    {"id": "btc-150k", "title": "比特币会在年底前突破 15 万美元吗？", "tag": "加密资产",
     "source": "系统出题", "due": "12 月 31 日截止", "agents": 23, "yes": 41},
    # 一道已揭晓的问题，用于演示结算回填与未来预测总榜
    {"id": "gold-record", "title": "现货黄金价格会在 9 月创下历史新高吗？", "tag": "贵金属",
     "source": "系统出题", "due": "9 月 30 日截止", "agents": 15, "yes": 47,
     "outcome": "YES"},
]


def _seed_demo_data() -> None:
    with db._lock:
        conn = db._get_conn()
        if conn.execute("SELECT COUNT(*) c FROM forecast_questions").fetchone()["c"] > 0:
            return
        ts = db.now_iso()
        for spec in _SEED_QUESTIONS:
            conn.execute(
                "INSERT INTO forecast_questions(id,title,tag,source,due,status,outcome,created_at,resolved_at)"
                " VALUES(?,?,?,?,?,?,?,?,?)",
                (spec["id"], spec["title"], spec["tag"], spec["source"], spec["due"],
                 "resolved" if spec.get("outcome") else "open", spec.get("outcome"), ts,
                 ts if spec.get("outcome") else None),
            )
            target = spec["yes"] / 100
            for i in range(spec["agents"]):
                jitter = (((i * 37) % 23) - 11) / 100  # -0.11 .. +0.11
                p_yes = min(0.95, max(0.05, target + jitter))
                direction = "YES" if p_yes >= 0.5 else "NO"
                probability = round(p_yes if direction == "YES" else 1 - p_yes, 3)
                name, model = _DEMO_AGENTS[i % len(_DEMO_AGENTS)]
                if i >= len(_DEMO_AGENTS):
                    name = f"{name}-{i // len(_DEMO_AGENTS) + 1}"
                is_correct = (1 if direction == spec["outcome"] else 0) if spec.get("outcome") else None
                conn.execute(
                    "INSERT INTO forecast_predictions(id,question_id,agent_id,agent_name,agent_model,"
                    "direction,probability,rationale,is_correct,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (f"{spec['id']}-seed-{i}", spec["id"], f"demo-{spec['id']}-{i}", name, model,
                     direction, probability, None, is_correct, ts),
                )
        conn.commit()
