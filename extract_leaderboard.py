#!/usr/bin/env python3
"""Extract leaderboard data from FinArena test database and prepare for backfill."""

import sqlite3
import json
import math
from collections import defaultdict

DB_PATH = "/tmp/FinArena-Local-macOS/data/arena.sqlite3"

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

# 1. Get all models
models = {}
for row in cur.execute("SELECT id, name, version, enabled, created_at FROM models"):
    models[row["id"]] = {
        "id": row["id"],
        "name": row["name"],
        "version": row["version"],
        "enabled": row["enabled"],
        "created_at": row["created_at"],
    }

print(f"=== Models ({len(models)}) ===")
for m in models.values():
    print(f"  {m['id']}: {m['name']} v{m['version']} (enabled={m['enabled']})")

# 2. Get all tasks
tasks = {}
for row in cur.execute("SELECT id, round_id, symbol, payload FROM tasks"):
    payload = json.loads(row["payload"])
    tasks[row["id"]] = {
        "id": row["id"],
        "round_id": row["round_id"],
        "symbol": row["symbol"],
        "name": payload.get("name", row["symbol"]),
        "payload": payload,
    }

print(f"\n=== Tasks ({len(tasks)}) ===")
for t in list(tasks.values())[:5]:
    print(f"  {t['id']}: {t['symbol']} ({t['name']}) round={t['round_id']}")

# 3. Get settled settlements
settlements = {}
for row in cur.execute(
    "SELECT task_id, horizon, payload FROM settlements WHERE JSON_EXTRACT(payload, '$.status') = 'settled'"
):
    payload = json.loads(row["payload"])
    key = (row["task_id"], row["horizon"])
    settlements[key] = {
        "task_id": row["task_id"],
        "horizon": row["horizon"],
        "actual_direction": payload.get("actual_direction"),
        "return_pct": payload.get("return_pct"),
        "target_date": payload.get("target_date"),
    }

print(f"\n=== Settled Settlements ({len(settlements)}) ===")
for s in list(settlements.values())[:5]:
    print(f"  {s['task_id']} h{s['horizon']}: {s['actual_direction']} ({s['return_pct']:.2f}%) target={s['target_date']}")

# 4. Get predictions that have settlements
predictions_with_outcome = []
for row in cur.execute(
    "SELECT task_id, model_id, horizon, payload FROM predictions"
):
    payload = json.loads(row["payload"])
    key = (row["task_id"], row["horizon"])
    if key in settlements:
        s = settlements[key]
        predictions_with_outcome.append({
            "task_id": row["task_id"],
            "model_id": row["model_id"],
            "horizon": row["horizon"],
            "direction": payload.get("direction"),
            "p_up": payload.get("p_up"),
            "rationale": payload.get("rationale", ""),
            "submitted_at": payload.get("submitted_at"),
            "actual_direction": s["actual_direction"],
            "return_pct": s["return_pct"],
        })

print(f"\n=== Predictions with Settlements ({len(predictions_with_outcome)}) ===")
for p in predictions_with_outcome[:5]:
    print(f"  task={p['task_id'][:12]} model={p['model_id'][:12]} h{p['horizon']} "
          f"pred={p['direction']}({p['p_up']}) actual={p['actual_direction']} ret={p['return_pct']:.2f}%")

# 5. Compute leaderboard metrics per model
print("\n=== Leaderboard Metrics ===")
print(f"{'Rank':<5} {'Model Name':<25} {'Settled':<10} {'Accuracy':<12} {'Brier':<10} {'Log Loss':<10}")
print("-" * 75)

model_stats = defaultdict(lambda: {"name": "", "correct": 0, "total": 0, "brier_sum": 0, "loss_sum": 0})

for p in predictions_with_outcome:
    mid = p["model_id"]
    m = models.get(mid)
    if not m:
        continue
    model_stats[mid]["name"] = m["name"]
    model_stats[mid]["total"] += 1

    direction = p["direction"]
    p_up = p["p_up"]
    actual = p["actual_direction"]

    prod_direction = "YES" if direction == "UP" else "NO"
    prod_probability = p_up if direction == "UP" else (1 - p_up)
    prod_outcome = "YES" if actual == "UP" else "NO"

    actual_val = 1 if prod_outcome == "YES" else 0
    prob = prod_probability if prod_direction == "YES" else (1 - prod_probability)

    if prod_direction == prod_outcome:
        model_stats[mid]["correct"] += 1
    model_stats[mid]["brier_sum"] += (prob - actual_val) ** 2
    pc = max(1e-6, min(1 - 1e-6, prob))
    model_stats[mid]["loss_sum"] += -(actual_val * math.log(pc) + (1 - actual_val) * math.log(1 - pc))

ranked = sorted(model_stats.items(), key=lambda x: (-x[1]["correct"] / max(x[1]["total"], 1), x[1]["brier_sum"] / max(x[1]["total"], 1)))

for rank, (mid, s) in enumerate(ranked, 1):
    total = s["total"]
    if total == 0:
        continue
    accuracy = s["correct"] / total
    brier = s["brier_sum"] / total
    log_loss = s["loss_sum"] / total
    print(f"{rank:<5} {s['name']:<25} {total:<10} {accuracy*100:<12.1f} {brier:<10.4f} {log_loss:<10.4f}")

# 6. Save extracted data as JSON for backfill
output = {
    "agents": [],
    "questions": [],
    "predictions": [],
}

for mid, m in models.items():
    model_type = "Custom"
    if "Pronoia" in m["name"]:
        model_type = "Multi-Agent"
    elif "DeepSeek" in m["name"]:
        model_type = "DeepSeek"
    elif "qwen" in m["name"].lower():
        model_type = "Qwen"

    output["agents"].append({
        "id": mid,
        "token": f"tok-{mid[-8:]}",
        "name": m["name"],
        "developer": "FinArena Test",
        "model": model_type,
        "framework": "",
        "created_at": m["created_at"],
    })

output["questions"] = []
seen_questions = set()
for p in predictions_with_outcome:
    t = tasks.get(p["task_id"])
    if not t:
        continue
    question_id = f"{p['task_id']}-h{p['horizon']}"
    if question_id in seen_questions:
        continue
    seen_questions.add(question_id)

    horizon_label = {1: "T+1", 3: "T+3", 5: "T+5"}.get(p["horizon"], f"T+{p['horizon']}")
    actual = p["actual_direction"]
    prod_outcome = "YES" if actual == "UP" else "NO"

    q_preds = [x for x in predictions_with_outcome if x["task_id"] == p["task_id"] and x["horizon"] == p["horizon"]]
    yes_count = sum(1 for x in q_preds if x["direction"] == "UP")
    total_count = len(q_preds)
    yes_pct = round((yes_count / total_count) * 100) if total_count > 0 else 50

    output["questions"].append({
        "id": question_id,
        "source": "系统出题",
        "tag": "个股预测",
        "title": f"{t['name']}({t['symbol']}) {horizon_label} 走势预测",
        "due": settlements[(p["task_id"], p["horizon"])]["target_date"],
        "agents": total_count,
        "yes": yes_pct,
        "status": "resolved",
        "outcome": prod_outcome,
    })

for p in predictions_with_outcome:
    m = models.get(p["model_id"])
    if not m:
        continue
    t = tasks.get(p["task_id"])
    if not t:
        continue

    direction = p["direction"]
    p_up = p["p_up"]
    actual = p["actual_direction"]

    prod_direction = "YES" if direction == "UP" else "NO"
    prod_probability = p_up if direction == "UP" else (1 - p_up)
    prod_outcome = "YES" if actual == "UP" else "NO"

    question_id = f"{p['task_id']}-h{p['horizon']}"

    output["predictions"].append({
        "id": f"p-{p['task_id'][-8:]}-{p['model_id'][-8:]}-h{p['horizon']}",
        "question_id": question_id,
        "agent_id": p["model_id"],
        "agent_name": m["name"],
        "direction": prod_direction,
        "probability": round(prod_probability, 4),
        "rationale": p["rationale"][:500],
        "outcome": prod_outcome,
        "created_at": p["submitted_at"] or "2026-09-17T00:00:00Z",
    })

with open("/workspace/leaderboard_data.json", "w", encoding="utf-8") as f:
    json.dump(output, f, ensure_ascii=False, indent=2)

print(f"\n=== Extracted Data Summary ===")
print(f"  Agents: {len(output['agents'])}")
print(f"  Questions: {len(output['questions'])}")
print(f"  Predictions: {len(output['predictions'])}")
print(f"\nData saved to /workspace/leaderboard_data.json")

conn.close()
