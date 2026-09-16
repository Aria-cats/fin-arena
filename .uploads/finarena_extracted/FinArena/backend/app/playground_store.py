"""Persistence helpers for the public Playground participant flow."""
from __future__ import annotations

import hashlib
import json
import secrets
from typing import Any

from . import db


def init_playground_tables() -> None:
    with db._lock:
        conn = db._get_conn()
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS playground_agents(
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                developer TEXT NOT NULL,
                model TEXT,
                framework TEXT,
                evomap_agent_id TEXT,
                token_hash TEXT NOT NULL UNIQUE,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS playground_submissions(
                id TEXT PRIMARY KEY,
                agent_id TEXT NOT NULL,
                challenge_id TEXT NOT NULL,
                score REAL NOT NULL,
                accuracy REAL NOT NULL,
                coverage REAL NOT NULL,
                predictions_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY(agent_id) REFERENCES playground_agents(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_pg_sub_agent ON playground_submissions(agent_id);
            CREATE INDEX IF NOT EXISTS idx_pg_sub_challenge ON playground_submissions(challenge_id, score DESC);
            """
        )
        existing = {row[1] for row in conn.execute("PRAGMA table_info(playground_submissions)").fetchall()}
        for name in ("brier", "log_loss", "calibration"):
            if name not in existing:
                conn.execute(f"ALTER TABLE playground_submissions ADD COLUMN {name} REAL NOT NULL DEFAULT 0")
        conn.commit()


def create_agent(*, name: str, developer: str, model: str = "", framework: str = "", evomap_agent_id: str = "") -> tuple[dict[str, Any], str]:
    token = "prn_" + secrets.token_urlsafe(24)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    row = {
        "id": "agt_" + db.new_id(),
        "name": name.strip(),
        "developer": developer.strip(),
        "model": model.strip(),
        "framework": framework.strip(),
        "evomap_agent_id": evomap_agent_id.strip(),
        "created_at": db.now_iso(),
    }
    with db._lock:
        conn = db._get_conn()
        conn.execute(
            "INSERT INTO playground_agents(id,name,developer,model,framework,evomap_agent_id,token_hash,created_at) VALUES(?,?,?,?,?,?,?,?)",
            (row["id"], row["name"], row["developer"], row["model"], row["framework"], row["evomap_agent_id"], token_hash, row["created_at"]),
        )
        conn.commit()
    return row, token


def agent_for_token(token: str) -> dict[str, Any] | None:
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    with db._lock:
        row = db._get_conn().execute(
            "SELECT id,name,developer,model,framework,evomap_agent_id,created_at FROM playground_agents WHERE token_hash=?",
            (token_hash,),
        ).fetchone()
    return dict(row) if row else None


def save_submission(*, agent_id: str, challenge_id: str, score: float, accuracy: float, coverage: float, brier: float = 0, log_loss: float = 0, calibration: float = 0, predictions: list[dict[str, Any]]) -> dict[str, Any]:
    row = {
        "id": "sub_" + db.new_id(),
        "agent_id": agent_id,
        "challenge_id": challenge_id,
        "score": score,
        "accuracy": accuracy,
        "coverage": coverage,
        "brier": brier,
        "log_loss": log_loss,
        "calibration": calibration,
        "created_at": db.now_iso(),
    }
    with db._lock:
        conn = db._get_conn()
        conn.execute(
            "INSERT INTO playground_submissions(id,agent_id,challenge_id,score,accuracy,coverage,brier,log_loss,calibration,predictions_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (row["id"], agent_id, challenge_id, score, accuracy, coverage, brier, log_loss, calibration, json.dumps(predictions, ensure_ascii=False), row["created_at"]),
        )
        conn.commit()
    return row


def leaderboard(challenge_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    params: list[Any] = []
    where = ""
    if challenge_id:
        where = "WHERE s.challenge_id=?"
        params.append(challenge_id)
    params.append(limit)
    with db._lock:
        rows = db._get_conn().execute(
            f"""
            WITH ranked AS (
                SELECT s.*, ROW_NUMBER() OVER (
                    PARTITION BY s.agent_id, s.challenge_id
                    ORDER BY s.score DESC, s.created_at ASC
                ) AS attempt_rank
                FROM playground_submissions s
                {where}
            )
            SELECT s.id,s.challenge_id,s.score,s.accuracy,s.coverage,s.brier,s.log_loss,s.calibration,s.created_at,
                   a.id AS agent_id,a.name,a.developer,a.model,a.framework,a.evomap_agent_id
            FROM ranked s
            JOIN playground_agents a ON a.id=s.agent_id
            WHERE s.attempt_rank=1
            ORDER BY s.score DESC,s.created_at ASC LIMIT ?
            """,
            tuple(params),
        ).fetchall()
    return [dict(row) for row in rows]
