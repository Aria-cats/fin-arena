export type ConnectedAgent = { agent_id:string; name:string; developer:string; model:string; framework:string; created_at:string; token?:never };
export type FutureQuestion = { question_id:string; title:string; description:string; rules:Record<"UP"|"FLAT"|"DOWN",string>; opens_at:string; closes_at:string; status:"open"|"closed"|"settled"; agent_count:number };
export type FutureSubmission = { submission_id:string; agent_id:string; question_id:string; agent_name?:string; developer?:string; model?:string; framework?:string; question_title?:string; question_status?:string; probability_up:number; probability_flat:number; probability_down:number; rationale:string; submitted_at:string; sealed:number; settlement_result:string|null; score:number|null };
export type MyAgentPayload = { agent:ConnectedAgent; submissions:FutureSubmission[] };
export type PublicQuestion = { id:string; source:string; tag:string; title:string; due:string; agents:number; yes:number; isPublic?:boolean; real?:boolean };
export type AgentTask = { question:string; status:string; submission_id?:string; probability_up?:number; probability_flat?:number; probability_down?:number; submitted_at?:string };
export type LeaderboardRow = string[];
export type AgentRegistrationInput = { name:string; developer:string; model:string; framework:string };

export interface FinArenaService {
  getConnectedAgent():Promise<ConnectedAgent|null>;
  getMe():Promise<MyAgentPayload|null>;
  bindAgent(token:string):Promise<{ok:true;submission_id:string}>;
  logoutAgent():Promise<void>;
  listFutureQuestions():Promise<FutureQuestion[]>;
  getFutureQuestion(id:string):Promise<FutureQuestion>;
  listFutureSubmissions(id:string):Promise<FutureSubmission[]>;
  getFutureLeaderboard(id:string):Promise<{settled:boolean;outcome:string|null;items:Array<FutureSubmission&{rank:number}>}>;
  listQuestions():Promise<PublicQuestion[]>;
  createQuestion(title:string,due:string):Promise<PublicQuestion[]>;
  listAgentTasks():Promise<AgentTask[]>;
  listFollowedQuestions():Promise<string[]>;
  toggleFollow(questionId:string):Promise<string[]>;
  getBacktestLeaderboard(horizon?:number):Promise<LeaderboardRow[]>;
  getForecastLeaderboard(horizon?:number):Promise<LeaderboardRow[]>;
  /** @deprecated Legacy UI only. Real identities can only be created by the backend. */
  saveConnectedAgent(input:AgentRegistrationInput):Promise<ConnectedAgent>;
  /** @deprecated Legacy UI only. Predictions must be submitted with an Agent token. */
  joinQuestion(question:PublicQuestion|string,agent?:ConnectedAgent):Promise<{tasks:AgentTask[];questions:PublicQuestion[]}>;
  /** @deprecated Legacy UI only. Clears the current browser session only. */
  resetDemo():Promise<void>;
}
