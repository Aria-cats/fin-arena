export type ConnectedAgent = { name: string; developer: string; model: string; token: string };

export type PublicQuestion = {
  id: string;
  source: string;
  tag: string;
  title: string;
  due: string;
  agents: number;
  yes: number;
};

export type AgentTask = { question: string; status: string };
export type LeaderboardRow = string[];

export type AgentRegistrationInput = {
  name: string;
  developer: string;
  model: string;
  framework: string;
};

export interface FinArenaService {
  getConnectedAgent(): Promise<ConnectedAgent | null>;
  saveConnectedAgent(agent: ConnectedAgent): Promise<void>;
  listQuestions(): Promise<PublicQuestion[]>;
  createQuestion(title: string, due: string): Promise<PublicQuestion[]>;
  listAgentTasks(): Promise<AgentTask[]>;
  joinQuestion(question: string): Promise<{ tasks: AgentTask[]; questions: PublicQuestion[] }>;
  listFollowedQuestions(): Promise<string[]>;
  toggleFollow(questionId: string): Promise<string[]>;
  getBacktestLeaderboard(): Promise<LeaderboardRow[]>;
  getForecastLeaderboard(): Promise<LeaderboardRow[]>;
  registerAgent(input: AgentRegistrationInput): Promise<{ token: string }>;
  resetDemo(): Promise<void>;
}
