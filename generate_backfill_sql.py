#!/usr/bin/env python3
"""Generate SQL for backfilling leaderboard data into D1 database."""

import json

with open("/workspace/leaderboard_data.json", "r", encoding="utf-8") as f:
    data = json.load(f)

sql_lines = []
sql_lines.append("-- Backfill leaderboard data from FinArena test database")
sql_lines.append("BEGIN TRANSACTION;")
sql_lines.append("")

# Clear existing data first (optional, but ensures clean state)
# sql_lines.append("DELETE FROM predictions;")
# sql_lines.append("DELETE FROM questions;")
# sql_lines.append("DELETE FROM agents;")
# sql_lines.append("")

# Insert agents
sql_lines.append("-- Agents")
for a in data["agents"]:
    name = a["name"].replace("'", "''")
    developer = a["developer"].replace("'", "''")
    model = a["model"].replace("'", "''")
    framework = a["framework"].replace("'", "''")
    sql_lines.append(
        f"INSERT OR IGNORE INTO agents (id, token, name, developer, model, framework, created_at) "
        f"VALUES ('{a['id']}', '{a['token']}', '{name}', '{developer}', '{model}', '{framework}', '{a['created_at']}');"
    )

sql_lines.append("")

# Insert questions
sql_lines.append("-- Questions")
for q in data["questions"]:
    title = q["title"].replace("'", "''")
    sql_lines.append(
        f"INSERT OR IGNORE INTO questions (id, source, tag, title, due, agents, yes, status, outcome) "
        f"VALUES ('{q['id']}', '{q['source']}', '{q['tag']}', '{title}', '{q['due']}', {q['agents']}, {q['yes']}, '{q['status']}', '{q['outcome']}');"
    )

sql_lines.append("")

# Insert predictions
sql_lines.append("-- Predictions")
for p in data["predictions"]:
    rationale = p["rationale"].replace("'", "''").replace("\n", " ")
    sql_lines.append(
        f"INSERT OR IGNORE INTO predictions (id, question_id, agent_id, agent_name, direction, probability, rationale, outcome, created_at) "
        f"VALUES ('{p['id']}', '{p['question_id']}', '{p['agent_id']}', '{p['agent_name'].replace(chr(39), chr(39)*2)}', '{p['direction']}', {p['probability']}, '{rationale}', '{p['outcome']}', '{p['created_at']}');"
    )

sql_lines.append("")
sql_lines.append("COMMIT;")

sql_content = "\n".join(sql_lines)
with open("/workspace/backfill.sql", "w", encoding="utf-8") as f:
    f.write(sql_content)

print(f"Generated {len(data['agents'])} agents, {len(data['questions'])} questions, {len(data['predictions'])} predictions")
print(f"SQL saved to /workspace/backfill.sql")
