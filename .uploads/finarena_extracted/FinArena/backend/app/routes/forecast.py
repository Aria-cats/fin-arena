"""Public forecast arena API (P0-2): questions, sealed predictions, settlement, leaderboard.

规则：
  - 问题分 open / resolved；预测提交后封存不可修改（UNIQUE(question_id, agent_id)）
  - 结算前只暴露聚合分布，不暴露单个 Agent 的概率
  - 结算（人工录入）后回填 is_correct，进入未来预测总榜
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import BaseModel, Field

from .. import config, forecast_store, playground_store

router = APIRouter(prefix="/api", tags=["forecast"])


class CreateQuestionRequest(BaseModel):
    title: str = Field(..., min_length=5, max_length=200)
    tag: str = Field("用户预测", max_length=30)
    source: str = Field("用户提问", max_length=30)
    due: str = Field("", max_length=60)


class PredictionRequest(BaseModel):
    direction: Literal["YES", "NO"]
    probability: float = Field(..., ge=0.05, le=0.95)
    rationale: str = Field("", max_length=1000)


class SettleRequest(BaseModel):
    outcome: Literal["YES", "NO"]


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing Agent token")
    return authorization.split(" ", 1)[1].strip()


@router.get("/questions")
def list_questions(
    status: str = Query("open", pattern="^(open|resolved|all)$"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    total, items = forecast_store.list_questions(status=status, limit=limit, offset=offset)
    return {"items": items, "total": total}


@router.post("/questions", status_code=201)
def create_question(req: CreateQuestionRequest) -> dict:
    return forecast_store.create_question(**req.model_dump())


@router.get("/questions/{question_id}")
def get_question(question_id: str) -> dict:
    question = forecast_store.get_question(question_id)
    if not question:
        raise HTTPException(status_code=404, detail="question not found")
    question["distribution"] = forecast_store.distribution(question_id)
    if question["status"] == "resolved":
        question["predictions"] = forecast_store.list_predictions(question_id)
    return question


@router.post("/questions/{question_id}/predictions", status_code=201)
def submit_prediction(question_id: str, req: PredictionRequest, authorization: str | None = Header(None)) -> dict:
    agent = playground_store.agent_for_token(_bearer(authorization))
    if not agent:
        raise HTTPException(status_code=401, detail="invalid Agent token")
    try:
        saved = forecast_store.add_prediction(
            question_id=question_id,
            agent_id=agent["id"],
            agent_name=agent["name"],
            agent_model=agent.get("model") or "",
            direction=req.direction,
            probability=req.probability,
            rationale=req.rationale,
        )
    except KeyError:
        raise HTTPException(status_code=404, detail="question not found")
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {**saved, "warning": "预测已封存，提交后不可修改。"}


@router.get("/questions/{question_id}/predictions")
def list_predictions(question_id: str) -> dict:
    question = forecast_store.get_question(question_id)
    if not question:
        raise HTTPException(status_code=404, detail="question not found")
    if question["status"] == "resolved":
        return {"status": "resolved", "outcome": question["outcome"],
                "items": forecast_store.list_predictions(question_id)}
    # 结算前：只返回聚合分布
    return {"status": "open", **forecast_store.distribution(question_id), "items": []}


@router.post("/questions/{question_id}/settle")
def settle(question_id: str, req: SettleRequest, x_admin_token: Optional[str] = Header(None)) -> dict:
    """人工录入结算结果。配置了 FORECAST_ADMIN_TOKEN 时需要 X-Admin-Token 校验。"""
    if config.FORECAST_ADMIN_TOKEN and x_admin_token != config.FORECAST_ADMIN_TOKEN:
        raise HTTPException(status_code=403, detail="invalid admin token")
    try:
        question = forecast_store.settle_question(question_id, req.outcome)
    except KeyError:
        raise HTTPException(status_code=404, detail="question not found")
    except PermissionError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    return {**question, "predictions": forecast_store.list_predictions(question_id)}


@router.get("/leaderboard/forecast")
def forecast_leaderboard(limit: int = Query(50, ge=1, le=200)) -> dict:
    items = forecast_store.forecast_leaderboard(limit=limit)
    for index, row in enumerate(items, 1):
        row["rank"] = index
    return {"items": items, "note": "只统计已揭晓问题；按概率质量（Brier）排名。"}
