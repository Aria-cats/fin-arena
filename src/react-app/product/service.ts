import type { AgentTask, LeaderboardRow, FinArenaService, PublicQuestion } from "./types";

export const defaultQuestions: PublicQuestion[] = [
  {id:"fed-rate",source:"系统出题",tag:"宏观",title:"美联储会在下一次议息会议上降息吗？",due:"6 天后截止",agents:18,yes:68},
  {id:"nvda-revenue",source:"用户提问",tag:"公司财报",title:"英伟达下一季度营收会超过市场预期吗？",due:"11 月 18 日截止",agents:12,yes:74},
  {id:"btc-150k",source:"系统出题",tag:"加密资产",title:"比特币会在年底前突破 15 万美元吗？",due:"12 月 31 日截止",agents:23,yes:41},
];

const fallbackBoard: LeaderboardRow[] = [
  ["1","Fin-Arena-RLVR-v2","GPT-4o","70.9","0.198","0.512","0.082","$0.034","Active"],
  ["2","Claude-Finance-v1","Claude 3.5 Sonnet","67.8","0.215","0.568","0.098","$0.028","Active"],
  ["3","DeepSeek-Finance","DeepSeek V3","64.7","0.231","0.595","0.121","$0.004","Active"],
  ["4","Fin-Arena-Baseline","GPT-4o","63.2","0.241","0.621","0.143","$0.031","Active"],
  ["5","Gemini-Finance-1.5","Gemini 1.5 Pro","62.8","0.247","0.632","0.155","$0.006","Active"],
  ["6","Random-Baseline","N/A","49.8","0.333","0.693","0.250","$0.000","Benchmark"],
];

export const fallbackForecastBoard: LeaderboardRow[] = [
  ["1","Atlas Team","Multi-Agent","71.4","0.181","0.493","0.071","—","Official"],
  ["2","MacroFox","GPT-5","69.8","0.184","0.501","0.076","$0.041","Settled"],
  ["3","Pulse Team","Multi-Agent","68.2","0.196","0.526","0.084","—","Official"],
  ["4","Signal Hunter","Claude Sonnet 4","66.9","0.207","0.551","0.091","$0.029","Settled"],
  ["5","Horizon Team","Multi-Agent","65.7","0.218","0.576","0.104","—","Official"],
];

const read = <T>(storage: Storage, key: string, fallback: T): T => {
  try { return JSON.parse(storage.getItem(key) || "null") ?? fallback; } catch { return fallback; }
};

type ApiQuestion = {
  id: string; source: string; tag: string; title: string; due: string;
  agents: number; yes: number; status: string; outcome: string | null;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  if (!response.ok) throw new Error(`api ${response.status}`);
  return response.json() as Promise<T>;
};

const toPublic = (q: ApiQuestion): PublicQuestion => ({
  id: q.id, source: q.source, tag: q.tag, title: q.title,
  due: q.due || "等待设定截止时间", agents: q.agents, yes: q.yes,
});

const apiListQuestions = async (): Promise<PublicQuestion[]> => {
  const data = await request<{items: ApiQuestion[]}>("/api/questions?status=open&limit=100");
  return data.items.map(toPublic);
};

export const finArenaService: FinArenaService = {
  async getConnectedAgent() { return read(sessionStorage, "finarena_connected_agent", null); },
  async saveConnectedAgent(agent) {
    sessionStorage.setItem("finarena_connected_agent", JSON.stringify(agent));
    sessionStorage.setItem("finarena_agent_token", agent.token);
  },
  async listQuestions() {
    try { return await apiListQuestions(); } catch { return read(localStorage, "finarena_public_questions", defaultQuestions); }
  },
  async createQuestion(title, due) {
    try {
      await request("/api/questions", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,due})});
      return await apiListQuestions();
    } catch {
      const current = read(localStorage, "finarena_public_questions", defaultQuestions);
      if (current.some(question => question.title === title)) return current;
      const next = [{id:`user-${Date.now()}`,source:"用户提问",tag:"用户预测",title,due,agents:3,yes:64}, ...current];
      localStorage.setItem("finarena_public_questions", JSON.stringify(next));
      return next;
    }
  },
  async listAgentTasks() { return read(localStorage, "finarena_agent_tasks", [] as AgentTask[]); },
  async joinQuestion(question) {
    const tasks = await this.listAgentTasks();
    const nextTasks = tasks.some(task => task.question === question) ? tasks : [{question,status:"预测中"}, ...tasks];
    localStorage.setItem("finarena_agent_tasks", JSON.stringify(nextTasks));
    try {
      const token = sessionStorage.getItem("finarena_agent_token") || "";
      const data = await request<{items: ApiQuestion[]}>("/api/questions?status=open&limit=100");
      const target = data.items.find(item => item.title === question);
      if (!target) throw new Error("question not found");
      await request(`/api/questions/${encodeURIComponent(target.id)}/predictions`, {
        method:"POST",
        headers:{"Content-Type":"application/json",...(token ? {Authorization:`Bearer ${token}`} : {})},
        body:JSON.stringify({direction:"YES",probability:0.55,rationale:"Web 端快速参赛"}),
      });
      return { tasks: nextTasks, questions: await apiListQuestions() };
    } catch {
      const questions = await this.listQuestions();
      const nextQuestions = questions.map(item => item.title === question ? {...item, agents:item.agents + 1} : item);
      localStorage.setItem("finarena_public_questions", JSON.stringify(nextQuestions));
      return { tasks: nextTasks, questions: nextQuestions };
    }
  },
  async listFollowedQuestions() { return read(localStorage, "finarena_followed", [] as string[]); },
  async toggleFollow(questionId) {
    const current = await this.listFollowedQuestions();
    const next = current.includes(questionId) ? current.filter(id => id !== questionId) : [...current, questionId];
    localStorage.setItem("finarena_followed", JSON.stringify(next));
    return next;
  },
  async getBacktestLeaderboard(challengeId) {
    try {
      const response = await fetch(`/api/playground/leaderboard?challenge_id=${encodeURIComponent(challengeId)}`);
      if (!response.ok) throw new Error("leaderboard unavailable");
      const data = await response.json();
      return data.items
        .filter((item: {name:string}) => !item.name.startsWith("Demo Agent") && item.name !== "Fin Arena Demo Agent")
        .map((item: Record<string, unknown>, index: number) => [String(index+1),String(item.name),String(item.model||"Custom"),String(Math.round(Number(item.accuracy)*1000)/10),Number(item.brier||0).toFixed(3),Number(item.log_loss||0).toFixed(3),Number(item.calibration||0).toFixed(3),"—","Active"]);
    } catch { return fallbackBoard; }
  },
  async getForecastLeaderboard() {
    try {
      const data = await request<{items: Record<string, unknown>[]}>("/api/leaderboard/forecast");
      return data.items.map((item) => [
        String(item.rank),String(item.name),String(item.model||"Custom"),
        String(Math.round(Number(item.accuracy)*1000)/10),Number(item.brier||0).toFixed(3),
        Number(item.log_loss||0).toFixed(3),Number(item.calibration||0).toFixed(3),"—","Settled",
      ]);
    } catch { return fallbackForecastBoard; }
  },
  async registerAgent(input) {
    const response = await fetch("/api/playground/agents", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...input,evomap_agent_id:""})});
    if (!response.ok) throw new Error("registration unavailable");
    return response.json();
  },
  async resetDemo() {
    ["finarena_connected_agent","finarena_agent_token"].forEach(key => sessionStorage.removeItem(key));
    ["finarena_agent_tasks","finarena_followed","finarena_public_questions"].forEach(key => localStorage.removeItem(key));
  },
};
