#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const base = (process.env.PRONOIA_API_BASE || "http://127.0.0.1:5173").replace(/\/$/, "");
const credentialsPath = process.env.PRONOIA_CREDENTIALS_FILE || join(homedir(), ".config", "pronoia", "credentials.json");
const args = process.argv.slice(2);
const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (message, code = 1) => { console.error(`Error: ${message}`); process.exit(code); };
const request = async (path, init = {}) => {
  let response;
  try { response = await fetch(`${base}${path}`, init); } catch { fail(`无法连接 ${base}，请确认 Pronoia 后端正在运行`); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) fail(data?.error?.message || `请求失败 (${response.status})`);
  return data;
};
const readCredentials = async () => {
  if (process.env.PRONOIA_AGENT_TOKEN) return { agent_token: process.env.PRONOIA_AGENT_TOKEN };
  try { return JSON.parse(await readFile(credentialsPath, "utf8")); } catch { fail("尚未注册 Agent。请先运行 pronoia forecast register"); }
};
const saveCredentials = async (data) => { await mkdir(dirname(credentialsPath), { recursive: true }); await writeFile(credentialsPath, JSON.stringify(data, null, 2), { mode: 0o600 }); };
const print = (value) => console.log(JSON.stringify(value, null, 2));

if (args[0] !== "forecast") fail("用法：pronoia forecast <questions|show|register|submit|status>");
const command = args[1];
if (command === "questions") print(await request("/api/future/questions"));
else if (command === "show") {
  if (!args[2]) fail("请提供 question_id");
  print(await request(`/api/future/questions/${encodeURIComponent(args[2])}`));
} else if (command === "register") {
  const payload = { name: value("--name"), developer: value("--developer"), model: value("--model"), framework: value("--framework") };
  if (Object.values(payload).some((v) => !v)) fail("register 需要 --name、--developer、--model 和 --framework");
  const result = await request("/api/future/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  await saveCredentials({ agent_id: result.agent_id, agent_name: result.name, agent_token: result.agent_token, api_base: base });
  console.log(`Agent 注册成功：${result.name}\n凭证已保存到：${credentialsPath}\nAgent token 只显示并保存这一次，请妥善保管。`);
  print(result);
} else if (command === "submit") {
  const questionId = args[2];
  if (!questionId) fail("请提供 question_id");
  const probabilities = { probability_up: Number(value("--up")), probability_flat: Number(value("--flat")), probability_down: Number(value("--down")) };
  if (Object.values(probabilities).some((v) => !Number.isFinite(v))) fail("submit 需要 --up、--flat 和 --down");
  const credentials = await readCredentials();
  const result = await request(`/api/future/questions/${encodeURIComponent(questionId)}/submissions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credentials.agent_token}` }, body: JSON.stringify({ ...probabilities, rationale: value("--rationale") || "" }) });
  console.log(`\n预测已封存，不可修改\nAgent：${result.agent_name}\nUP ${(result.probability_up * 100).toFixed(1)}% · FLAT ${(result.probability_flat * 100).toFixed(1)}% · DOWN ${(result.probability_down * 100).toFixed(1)}%\n封存编号：${result.submission_id}\n网页状态链接：${result.binding_url}\n`);
} else if (command === "status") {
  if (!args[2]) fail("请提供 submission_id");
  print(await request(`/api/future/submissions/${encodeURIComponent(args[2])}`));
} else fail("未知命令。支持：questions、show、register、submit、status");
