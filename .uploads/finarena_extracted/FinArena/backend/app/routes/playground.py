"""Public Playground API: register agents, fetch challenges, submit predictions."""
from __future__ import annotations

import json
import hashlib
import math
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from ..config import PROJECT_ROOT
from .. import playground_store

router = APIRouter(prefix="/api/playground", tags=["playground"])

CHALLENGES = {
    "cn-us-open-20": {
        "id": "cn-us-open-20",
        "name": "CN + US · Open Event Sprint",
        "description": "从公开的1000条中美股事件池分层抽取20题，提交后立即结算。",
        "events": PROJECT_ROOT / "backtesting" / "events_cn_us_1000_v1.jsonl",
        "labels": PROJECT_ROOT / "backtesting" / "labels_cn_us_1000_v1.jsonl",
        "count": 20,
        "sample_size": 20,
        "status": "open",
        "dataset_version": "cn_us_1000_v1",
        "evaluation_mode": "open_backtest",
    },
    "cn-us-open-1000": {
        "id": "cn-us-open-1000",
        "name": "CN + US · Full Open Benchmark",
        "description": "完整1000条公开历史金融事件回测。",
        "events": PROJECT_ROOT / "backtesting" / "events_cn_us_1000_v1.jsonl",
        "labels": PROJECT_ROOT / "backtesting" / "labels_cn_us_1000_v1.jsonl",
        "count": 1000,
        "status": "open",
        "dataset_version": "cn_us_1000_v1",
        "evaluation_mode": "open_backtest",
    },
    "us-stocks-10": {
        "id": "us-stocks-10",
        "name": "US Stocks · Event Reaction Sprint",
        "description": "根据事件发生时的信息，预测标的相对基准的后续方向。",
        "events": PROJECT_ROOT / "backtesting" / "events_us_stock_10.jsonl",
        "labels": PROJECT_ROOT / "backtesting" / "labels_us_stock_10.jsonl",
        "count": 10,
        "status": "open",
    },
    "cn-stocks-10": {
        "id": "cn-stocks-10",
        "name": "CN Stocks · Event Reaction Sprint",
        "description": "用A股公告事件测试 Agent 的方向判断能力。",
        "events": PROJECT_ROOT / "backtesting" / "events_cn_stock_10.jsonl",
        "labels": PROJECT_ROOT / "backtesting" / "labels_cn_stock_10.jsonl",
        "count": 10,
        "status": "open",
    },
}


class RegisterAgentRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=60)
    developer: str = Field(..., min_length=1, max_length=60)
    model: str = Field("", max_length=80)
    framework: str = Field("", max_length=80)
    evomap_agent_id: str = Field("", max_length=120)


class Prediction(BaseModel):
    event_id: str
    direction: Literal["up", "down", "neutral"]
    confidence: float = Field(..., ge=0, le=1)
    rationale: str = Field("", max_length=1000)


class SubmitRequest(BaseModel):
    challenge_id: str
    predictions: list[Prediction] = Field(..., min_length=1, max_length=1000)


def _read_jsonl(path: Path) -> list[dict]:
    if not path.is_file():
        raise HTTPException(status_code=503, detail=f"challenge data unavailable: {path.name}")
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _public_challenge(item: dict) -> dict:
    return {key: value for key, value in item.items() if key not in {"events", "labels"}}


def _challenge_events(item: dict) -> list[dict]:
    """Return a stable, stratified slice so every agent receives the same sprint."""
    events = _read_jsonl(item["events"])
    sample_size = item.get("sample_size")
    if not sample_size or sample_size >= len(events):
        return events
    buckets: dict[tuple[str, str], list[dict]] = {}
    for event in events:
        key = (str(event.get("market") or ""), str(event.get("event_type_l2") or ""))
        buckets.setdefault(key, []).append(event)
    for rows in buckets.values():
        rows.sort(key=lambda row: hashlib.sha256(str(row.get("event_id", "")).encode()).hexdigest())
    selected: list[dict] = []
    ordered = sorted(buckets)
    cursor = 0
    while len(selected) < sample_size and ordered:
        key = ordered[cursor % len(ordered)]
        rows = buckets[key]
        if rows:
            selected.append(rows.pop(0))
        if not rows:
            ordered.remove(key)
            cursor = 0
        else:
            cursor += 1
    return selected


def _prediction_probability(direction: str, confidence: float) -> dict[str, float]:
    confidence = min(max(confidence, 1e-6), 1 - 1e-6)
    remainder = (1 - confidence) / 2
    return {label: confidence if label == direction else remainder for label in ("up", "down", "neutral")}


def _metrics(submitted: dict, labels: dict[str, str]) -> dict[str, float | int]:
    valid = [(pred, labels[event_id]) for event_id, pred in submitted.items() if labels[event_id] in {"up", "down", "neutral"}]
    if not valid:
        return {"correct": 0, "accuracy": 0.0, "brier": 1.0, "log_loss": 20.0, "calibration": 1.0}
    correctness: list[int] = []
    briers: list[float] = []
    losses: list[float] = []
    calibration_pairs: list[tuple[float, int]] = []
    for pred, truth in valid:
        probs = _prediction_probability(pred.direction, pred.confidence)
        hit = int(pred.direction == truth)
        correctness.append(hit)
        briers.append(sum((probs[label] - int(label == truth)) ** 2 for label in probs) / 3)
        losses.append(-math.log(max(probs[truth], 1e-9)))
        calibration_pairs.append((pred.confidence, hit))
    ece = 0.0
    for low in [0.0, 0.2, 0.4, 0.6, 0.8]:
        bucket = [(confidence, hit) for confidence, hit in calibration_pairs if low <= confidence < low + 0.2 or (low == 0.8 and confidence == 1.0)]
        if bucket:
            ece += len(bucket) / len(valid) * abs(sum(x[0] for x in bucket) / len(bucket) - sum(x[1] for x in bucket) / len(bucket))
    return {
        "correct": sum(correctness),
        "accuracy": sum(correctness) / len(valid),
        "brier": sum(briers) / len(valid),
        "log_loss": sum(losses) / len(valid),
        "calibration": ece,
    }


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing Agent token")
    return authorization.split(" ", 1)[1].strip()


@router.get("/challenges")
def list_challenges() -> dict:
    return {"items": [_public_challenge(item) for item in CHALLENGES.values()]}


@router.get("/challenges/{challenge_id}")
def get_challenge(challenge_id: str) -> dict:
    item = CHALLENGES.get(challenge_id)
    if not item:
        raise HTTPException(status_code=404, detail="challenge not found")
    events = _challenge_events(item)
    safe_events = [{key: value for key, value in event.items() if key != "source_url"} for event in events]
    return {**_public_challenge(item), "events": safe_events}


@router.post("/agents")
def register_agent(req: RegisterAgentRequest) -> dict:
    agent, token = playground_store.create_agent(**req.model_dump())
    return {"agent": agent, "token": token, "warning": "Token 只显示一次，请保存在本地。"}


@router.post("/submissions")
def submit(req: SubmitRequest, authorization: str | None = Header(None)) -> dict:
    agent = playground_store.agent_for_token(_bearer(authorization))
    if not agent:
        raise HTTPException(status_code=401, detail="invalid Agent token")
    item = CHALLENGES.get(req.challenge_id)
    if not item:
        raise HTTPException(status_code=404, detail="challenge not found")
    challenge_event_ids = {row["event_id"] for row in _challenge_events(item)}
    labels = {row["event_id"]: row.get("label_avg_all") or row.get("label_t3") for row in _read_jsonl(item["labels"]) if row["event_id"] in challenge_event_ids}
    submitted = {row.event_id: row for row in req.predictions if row.event_id in labels}
    if not submitted:
        raise HTTPException(status_code=400, detail="no valid event_id in submission")
    metrics = _metrics(submitted, labels)
    correct = int(metrics["correct"])
    total = len(labels)
    accuracy = float(metrics["accuracy"])
    coverage = len(submitted) / total if total else 0
    score = round(100 * accuracy * (0.5 + 0.5 * coverage), 2)
    saved = playground_store.save_submission(
        agent_id=agent["id"], challenge_id=req.challenge_id, score=score,
        accuracy=round(accuracy, 4), coverage=round(coverage, 4),
        brier=round(float(metrics["brier"]), 4), log_loss=round(float(metrics["log_loss"]), 4),
        calibration=round(float(metrics["calibration"]), 4),
        predictions=[row.model_dump() for row in req.predictions],
    )
    return {**saved, "agent": agent, "correct": correct, "submitted": len(submitted), "total": total, "rank_note": "开放历史回测成绩，用于同题相对比较，不代表真实前瞻预测能力。"}


@router.get("/leaderboard")
def get_leaderboard(challenge_id: str | None = None, limit: int = Query(50, ge=1, le=200)) -> dict:
    rows = playground_store.leaderboard(challenge_id=challenge_id, limit=limit)
    for index, row in enumerate(rows, 1):
        row["rank"] = index
    return {"items": rows, "self_reported": True}
