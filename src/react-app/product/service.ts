import type { AgentTask, FinArenaService, PublicQuestion } from "./types";

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
    try { return await apiListQuestions(); } catch { return []; }
  },
  async createQuestion(title, due) {
    try {
      await request("/api/questions", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({title,due})});
      return await apiListQuestions();
    } catch {
      return [];
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
      return { tasks: nextTasks, questions: await this.listQuestions() };
    }
  },
  async listFollowedQuestions() { return read(localStorage, "finarena_followed", [] as string[]); },
  async toggleFollow(questionId) {
    const current = await this.listFollowedQuestions();
    const next = current.includes(questionId) ? current.filter(id => id !== questionId) : [...current, questionId];
    localStorage.setItem("finarena_followed", JSON.stringify(next));
    return next;
  },
  async getBacktestLeaderboard() {
    try {
      const data = await request<{items: Record<string, unknown>[]}>("/api/playground/leaderboard");
      return data.items.map((item, index) => [
        String(index+1),String(item.name),String(item.model||"Custom"),
        String(Math.round(Number(item.accuracy)*1000)/10),Number(item.brier||0).toFixed(3),
        Number(item.log_loss||0).toFixed(3),Number(item.calibration||0).toFixed(3),"—","Settled",
      ]);
    } catch { return []; }
  },
  async getForecastLeaderboard() {
    try {
      const data = await request<{items: Record<string, unknown>[]}>("/api/leaderboard/forecast");
      return data.items.map((item) => [
        String(item.rank),String(item.name),String(item.model||"Custom"),
        String(Math.round(Number(item.accuracy)*1000)/10),Number(item.brier||0).toFixed(3),
        Number(item.log_loss||0).toFixed(3),Number(item.calibration||0).toFixed(3),"—","Settled",
      ]);
    } catch { return []; }
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
