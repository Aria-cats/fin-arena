import type { FinArenaService, FutureQuestion, FutureSubmission, MyAgentPayload, PublicQuestion } from "./types";

export class ApiError extends Error { constructor(public status:number,public code:string,message:string){super(message)} }
const request=async<T>(path:string,init?:RequestInit):Promise<T>=>{let response:Response;try{response=await fetch(path,{credentials:"include",...init})}catch{throw new ApiError(0,"BACKEND_UNAVAILABLE","无法连接 Pronoia 后端，请确认服务正在运行")}const data=await response.json().catch(()=>({}));if(!response.ok){const error=(data as any)?.error;throw new ApiError(response.status,error?.code||"API_ERROR",error?.message||`请求失败 (${response.status})`)}return data as T};
const read=<T>(key:string,fallback:T):T=>{try{return JSON.parse(localStorage.getItem(key)||"null")??fallback}catch{return fallback}};
const toPublic=(q:FutureQuestion):PublicQuestion=>({id:q.question_id,source:"官方真实赛题",tag:"可真实参赛 · 美股 T+3",title:q.title,due:new Date(q.closes_at).toLocaleString("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit"})+" 截止",agents:Number(q.agent_count||0),yes:0,real:true});

export const finArenaService:FinArenaService={
  async getConnectedAgent(){return (await this.getMe())?.agent||null},
  async getMe(){try{return await request<MyAgentPayload>("/api/future/me")}catch(error){if(error instanceof ApiError&&error.status===401)return null;throw error}},
  bindAgent(token){return request(`/api/future/bind/${encodeURIComponent(token)}`,{method:"POST"})},
  async logoutAgent(){await request("/api/future/logout",{method:"POST"})},
  async listFutureQuestions(){return (await request<{items:FutureQuestion[]}>("/api/future/questions")).items},
  getFutureQuestion(id){return request(`/api/future/questions/${encodeURIComponent(id)}`)},
  async listFutureSubmissions(id){return (await request<{items:FutureSubmission[]}>(`/api/future/questions/${encodeURIComponent(id)}/submissions`)).items},
  getFutureLeaderboard(id){return request(`/api/future/questions/${encodeURIComponent(id)}/leaderboard`)},
  async listQuestions(){return (await this.listFutureQuestions()).map(toPublic)},
  async createQuestion(){throw new ApiError(501,"NOT_IMPLEMENTED","本阶段只开放 NVDA T+3 真实赛题")},
  async listAgentTasks(){const me=await this.getMe();return me?me.submissions.map(s=>({question:s.question_title||s.question_id,status:s.settlement_result?`已结算 · ${s.settlement_result}`:"已封存，等待揭晓",submission_id:s.submission_id,probability_up:s.probability_up,probability_flat:s.probability_flat,probability_down:s.probability_down,submitted_at:s.submitted_at})):[]},
  async listFollowedQuestions(){return read("finarena_followed",[] as string[])},
  async toggleFollow(questionId){const current=await this.listFollowedQuestions();const next=current.includes(questionId)?current.filter(id=>id!==questionId):[...current,questionId];localStorage.setItem("finarena_followed",JSON.stringify(next));return next},
  async getBacktestLeaderboard(horizon){const url=horizon?`/api/playground/leaderboard?horizon=${horizon}`:"/api/playground/leaderboard";const data=await request<{items:Record<string,unknown>[]}>(url);return data.items.map(item=>[String(item.rank),String(item.name),String(item.model||"Custom"),String(Math.round(Number(item.accuracy)*1000)/10),Number(item.brier||0).toFixed(3),Number(item.log_loss||0).toFixed(3),Number(item.calibration||0).toFixed(3),`${item.correct} / ${item.total}`])},
  async getForecastLeaderboard(horizon){const url=horizon?`/api/leaderboard/forecast?horizon=${horizon}`:"/api/leaderboard/forecast";const data=await request<{items:Record<string,unknown>[]}>(url);return data.items.map(item=>[String(item.rank),String(item.name),String(item.model||"Custom"),String(Math.round(Number(item.accuracy)*1000)/10),String(Math.round(Number(item.answered_accuracy)*1000)/10),String(item.correct||0),String(item.total||0),String(item.status||"观察中")])}
  ,async saveConnectedAgent(){throw new ApiError(410,"LEGACY_FLOW_REMOVED","请通过 CLI/API 注册 Agent，并使用一次性状态链接绑定")}
  ,async joinQuestion(){throw new ApiError(410,"LEGACY_FLOW_REMOVED","请让 Agent 使用 token 通过真实预测接口提交")}
  ,async resetDemo(){await this.logoutAgent()}
};
