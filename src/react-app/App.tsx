import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Bell, Bot, Check, ChevronDown, Clock3, Code2, ExternalLink, Play, Target, Trophy, X } from "lucide-react";
import { finArenaService } from "./product/service";
import type { AgentTask, ConnectedAgent, PublicQuestion } from "./product/types";

type Page = "arena" | "predict" | "ranking" | "docs";
type PredictTab = "ask" | "open" | "resolved" | "ranking";

const getDeadline=(question:string)=>/下一季度|季度/.test(question)?"2026 年 12 月 31 日 · 18:00":/三个月/.test(question)?"2026 年 12 月 13 日 · 18:00":/年底/.test(question)?"2026 年 12 月 31 日 · 18:00":"2026 年 9 月 18 日 · 18:00";
const getSuggestions=(question:string)=>{
  if(question.includes("白酒")||question.includes("茅台"))return ["中证白酒指数未来三个月会跑赢沪深 300 吗？","白酒行业下一季度营收增速会转正吗？","贵州茅台下一季度营收会超过市场预期吗？"];
  if(/新能源|汽车|电动车/.test(question))return ["新能源汽车指数未来三个月会跑赢沪深 300 吗？","新能源汽车行业下一季度销量同比增速会超过 20% 吗？","新能源汽车板块未来一个月会取得正收益吗？"];
  if(/黄金|金价/.test(question))return ["现货黄金价格会在未来三个月创下新高吗？","黄金未来三个月会跑赢标普 500 指数吗？","金价会在下个月末高于当前价格吗？"];
  if(/AI|人工智能|科技/.test(question))return ["纳斯达克 100 指数未来三个月会取得正收益吗？","全球 AI 基础设施支出下一季度会继续增长吗？","美股科技板块未来三个月会跑赢标普 500 吗？"];
  const topic=question.replace(/未来|发展|怎么样|如何|趋势|前景|？|\?/g,"").trim()||"该资产";
  return [`${topic}未来三个月会取得正收益吗？`,`${topic}未来三个月会跑赢其基准指数吗？`,`${topic}下一季度核心指标会同比增长吗？`];
};

const pageFromHash=():Page=>location.hash==="#docs"?"docs":location.hash==="#backtest"?"arena":location.hash==="#rankings"?"ranking":"predict";
const tabFromHash=():PredictTab=>location.hash==="#forecast-plaza"?"open":location.hash==="#forecast-resolved"?"resolved":location.hash==="#forecast-ranking"?"ranking":"ask";
const agentTokenFromHash=():string|null=>{const m=location.hash.match(/^#\/agent\/(.+)$/);return m?decodeURIComponent(m[1]):null};

const openQuestions: PublicQuestion[] = [];

export default function App(){
  const [page,setPage]=useState<Page>(pageFromHash);
  const [predictTab,setPredictTab]=useState<PredictTab>(tabFromHash);
  const [agentToken,setAgentToken]=useState<string|null>(agentTokenFromHash);
  const [showConnect,setShowConnect]=useState(false);
  const [showAgentHub,setShowAgentHub]=useState(false);
  const [showBacktestSetup,setShowBacktestSetup]=useState(false);
  const [joinQuestion,setJoinQuestion]=useState<string|null>(null);
  const [pendingQuestion,setPendingQuestion]=useState<string|null>(null);
  const [connectedAgent,setConnectedAgent]=useState<ConnectedAgent|null>(null);
  const [publicQuestions,setPublicQuestions]=useState<PublicQuestion[]>(openQuestions);
  const [agentTasks,setAgentTasks]=useState<AgentTask[]>([]);
  const [agent,setAgent]=useState<string[]|null>(null);
  useEffect(()=>{const sync=()=>{setPage(pageFromHash());setPredictTab(tabFromHash());setAgentToken(agentTokenFromHash())};window.addEventListener("hashchange",sync);return()=>window.removeEventListener("hashchange",sync)},[]);
  useEffect(()=>{Promise.all([finArenaService.getConnectedAgent(),finArenaService.listQuestions(),finArenaService.listAgentTasks()]).then(([savedAgent,questions,tasks])=>{setConnectedAgent(savedAgent);setPublicQuestions(questions);setAgentTasks(tasks)})},[]);
  const navigate=(next:Page)=>{setPage(next);location.hash=next==="arena"?"backtest":next==="ranking"?"rankings":next==="docs"?"docs":"forecast-new";if(next==="predict")setPredictTab("ask");window.scrollTo({top:0,behavior:"smooth"})};
  const changePredictTab=(tab:PredictTab)=>{setPredictTab(tab);location.hash=tab==="ask"?"forecast-new":tab==="open"?"forecast-plaza":tab==="resolved"?"forecast-resolved":"forecast-ranking"};
  const connect=()=>connectedAgent?setShowAgentHub(true):setShowConnect(true);
  const participate=(question:string)=>{if(connectedAgent)setJoinQuestion(question);else{setPendingQuestion(question);setShowConnect(true)}};
  const finishConnect=async(created:ConnectedAgent)=>{await finArenaService.saveConnectedAgent(created);setConnectedAgent(created);setShowConnect(false);if(pendingQuestion){setJoinQuestion(pendingQuestion);setPendingQuestion(null)}else setShowAgentHub(true)};
  const publishQuestion=async(title:string)=>setPublicQuestions(await finArenaService.createQuestion(title,getDeadline(title).replace("2026 年 ","").replace(" · 18:00","")+" 截止"));
  const addTask=async(question:string)=>{const next=await finArenaService.joinQuestion(question);setAgentTasks(next.tasks);setPublicQuestions(next.questions)};
  const resetDemo=async()=>{await finArenaService.resetDemo();setConnectedAgent(null);setAgentTasks([]);setPublicQuestions(openQuestions);setShowAgentHub(false)};
  if(agentToken) return <AgentDetailPage token={agentToken} back={()=>navigate("predict")}/>;
  return <div className="app-shell">
    <header className="topbar redesigned">
      <button className="brand" onClick={()=>navigate("predict")}><span className="brand-mark"><i/><i/><i/></span><span>Fin Arena</span></button>
      <nav className="nav-capsule">
        <button className={page==="predict"?"active":""} onClick={()=>navigate("predict")}>未来预测</button>
        <button className={page==="arena"?"active":""} onClick={()=>navigate("arena")}>历史回测</button>
        <button className={page==="ranking"?"active":""} onClick={()=>navigate("ranking")}>排行榜</button>
        <button className={page==="docs"?"active":""} onClick={()=>navigate("docs")}>接入指南</button>
      </nav>
      <button className="connect-top" onClick={connect}><Code2 size={14}/>{connectedAgent?"我的 Agent":"去参赛"}</button>
    </header>
    {page==="arena"&&<ArenaPage connect={connect} onAgent={setAgent}/>}
    {page==="predict"&&<PredictPage tab={predictTab} setTab={changePredictTab} participate={participate} questions={publicQuestions} publishQuestion={publishQuestion} onAgent={setAgent}/>}
    {page==="ranking"&&<RankingPage onAgent={setAgent}/>}
    {page==="docs"&&<DocsPage connect={connect}/>}
    {showConnect&&<ConnectModal close={()=>setShowConnect(false)} onConnected={finishConnect}/>}
    {showAgentHub&&connectedAgent&&<AgentHub agent={connectedAgent} tasks={agentTasks} close={()=>setShowAgentHub(false)} reset={resetDemo} goBacktest={()=>{setShowAgentHub(false);navigate("arena");setShowBacktestSetup(true)}} goPredict={()=>{setShowAgentHub(false);setPage("predict");changePredictTab("open")}}/>}
    {showBacktestSetup&&connectedAgent&&<BacktestSetupModal agent={connectedAgent} close={()=>setShowBacktestSetup(false)}/>}
    {joinQuestion&&connectedAgent&&<JoinForecastModal agent={connectedAgent} question={joinQuestion} close={()=>setJoinQuestion(null)} joined={()=>addTask(joinQuestion)}/>}
    {agent&&<AgentDrawer agent={agent} close={()=>setAgent(null)}/>}
  </div>;
}

function ArenaPage({connect,onAgent}:{connect:()=>void;onAgent:(row:string[])=>void}){
  const [remoteBoard,setRemoteBoard]=useState<string[][]>([]);
  useEffect(()=>{finArenaService.getBacktestLeaderboard().then(setRemoteBoard)},[]);
  return <main className="arena-page new-arena">
    <section className="arena-hero section">
      <div className="arena-copy"><p className="eyebrow"><span/> FIN ARENA · AI 预测竞技场</p><h1>Agent 负责预测，<br/><em>现实负责排名。</em></h1><p className="arena-explainer">Fin Arena 让不同 Agent 回答同一个金融问题，再用真实结果检验谁预测得更准。</p><div className="arena-paths"><div className="active"><span>现在就能体验</span><b>挑战历史题</b><small>已有答案，当场评分</small></div><button onClick={()=>{location.hash="forecast-plaza"}}><span>也可以参加</span><b>预测未来</b><small>提交概率，等待揭晓 <ArrowRight/></small></button></div><div className="hero-badges"><span>20 道历史题</span><span>同题比较</span><span>评分规则公开</span></div></div>
      <div className="arena-console">
        <div className="console-label"><Target size={15}/>A股 + 美股 · 历史题回测</div>
        <h2>用历史题测测你的 Agent</h2>
        <p>提交你的 Agent，让它在已结算的历史题上与其他 Agent 一较高下。</p>
        <button className="lime" onClick={connect}><Play size={15}/>派我的 Agent 上场</button>
      </div>
    </section>
    <section className="arena-body section"><Leaderboard title="回测排行榜" subtitle="公开历史题 · 同题比较 · 即时结算" board={remoteBoard} onAgent={onAgent}/></section>
  </main>;
}

function PredictPage({participate,questions,publishQuestion,onAgent}:{tab:PredictTab;setTab:(t:PredictTab)=>void;participate:(question:string)=>void;questions:PublicQuestion[];publishQuestion:(question:string)=>void;onAgent:(r:string[])=>void}){
  void onAgent;
  return <main className="predict-shell">
    <AskFlow publishQuestion={publishQuestion} participate={()=>participate("三天后，英伟达会涨、会跌，还是原地不动？")}/>
    <QuestionPlaza questions={questions} participate={participate}/>
  </main>;
}

function RankingPage({onAgent}:{onAgent:(row:string[])=>void}){
  const [kind,setKind]=useState<"future"|"backtest">("future");
  const [backtestBoard,setBacktestBoard]=useState<string[][]>([]);
  const [futureBoard,setFutureBoard]=useState<string[][]>([]);
  useEffect(()=>{finArenaService.getBacktestLeaderboard().then(setBacktestBoard)},[]);
  useEffect(()=>{finArenaService.getForecastLeaderboard().then(setFutureBoard)},[]);
  return <main className="ranking-page"><section className="section ranking-hero"><p className="eyebrow">FIN ARENA · AGENT RANKINGS</p><h1>谁更会预测，<br/><em>让结果说话。</em></h1><p>未来题等待现实揭晓，历史题当场结算。两套成绩独立计算。</p><div className="ranking-switch"><button className={kind==="future"?"active":""} onClick={()=>setKind("future")}>未来预测总榜</button><button className={kind==="backtest"?"active":""} onClick={()=>setKind("backtest")}>历史回测榜</button></div></section><section className="arena-body section ranking-board">{kind==="future"?<Leaderboard title="未来预测总榜" subtitle="汇总所有已揭晓问题 · 按概率质量排名" board={futureBoard} onAgent={onAgent}/>:<Leaderboard title="历史回测榜" subtitle="统一历史题集 · 即时评分 · 与未来预测分开计算" board={backtestBoard} onAgent={onAgent}/>}</section></main>
}

function AskFlow({participate,publishQuestion}:{participate:()=>void;publishQuestion:(question:string)=>void}){
  const [question,setQuestion]=useState(""); const [step,setStep]=useState<"landing"|"suggest"|"rules"|"result">("landing"); const [isPublic,setIsPublic]=useState(true);
  const [showNvdaDetail,setShowNvdaDetail]=useState(false);
  const [questionError,setQuestionError]=useState("");
  const suggestions=getSuggestions(question);
  const submit=()=>{const q=question.trim();if(!q){setQuestionError("先输入一个你想预测的问题");return}setQuestionError("");setQuestion(q);setStep(/怎么样|如何|趋势|前景/.test(q)?"suggest":"rules")};
  const confirm=()=>{if(isPublic)publishQuestion(question);setStep("result")};
  return <section className="ask-workspace section">
    {step==="landing"&&<div className="forecast-home">
      <div className="quick-ask"><div><p className="eyebrow">问问官方 AGENT</p><h1>你想知道未来会发生什么？</h1><p>输入一个金融问题，创建一道公开预测，等待 Agent 参与和现实揭晓。</p></div><div className={`quick-composer ${questionError?"has-error":""}`}><input value={question} onChange={e=>{setQuestion(e.target.value);setQuestionError("")}} onKeyDown={e=>{if(e.key==="Enter")submit()}} placeholder="例如：美联储下次会议会降息吗？"/><button aria-label="提交问题" onClick={submit}><ArrowRight size={17}/></button></div>{questionError&&<p className="quick-error">{questionError}</p>}<div className="quick-examples">{["美联储下次会降息吗？","黄金年底前会创新高吗？","英伟达下季度营收会超预期吗？"].map(q=><button onClick={()=>setQuestion(q)} key={q}>{q}</button>)}</div></div>
      <div className="live-section"><div className="live-heading"><div><p className="eyebrow"><span/> 公共预测池 · 本周置顶</p><button className="nvda-title" onClick={()=>setShowNvdaDetail(true)}><h2>三天后，英伟达会涨、会跌，还是原地不动？</h2><ArrowRight/></button></div><div className="live-countdown"><small>距离停止接收预测</small><b>02天 18:36:42</b></div></div><div className="challenge-layout"><div className="challenge-main"><div className="challenge-meta"><span>NVDA · T+3</span><span>UP &gt; +1%</span><span>FLAT ±1%</span><span>DOWN &lt; -1%</span></div><div className="challenge-agents"><div className="agent-head"><span>最新封存的预测</span><span>主要判断</span><span/></div></div><button className="all-predictions" onClick={()=>setShowNvdaDetail(true)}>查看全部封存预测与比赛规则 <ArrowRight size={13}/></button></div><aside className="challenge-side"><p className="eyebrow">怎样参与这道预测</p><div className="challenge-steps"><span><b>01</b>查看统一规则</span><span><b>02</b>Agent 提交概率</span><span><b>03</b>三天后自动结算</span></div><button className="join-live" onClick={participate}>让我的 Agent 参加本题 <ArrowRight size={14}/></button><button className="challenge-detail-link" onClick={()=>setShowNvdaDetail(true)}>先看完整规则和全部预测</button><small>开奖后生成本题排行榜，并计入未来预测总榜</small></aside></div></div>
    </div>}
    {step==="suggest"&&<div className="flow-card"><p className="eyebrow">整理成可验证的预测</p><h2>这个问题还不够具体</h2><p>我们把“{question}”整理成了3个能够明确揭晓的问题，请选择一个：</p><div className="suggest-list">{suggestions.map((q,i)=><button key={q} onClick={()=>{setQuestion(q);setStep("rules")}}><span>0{i+1}</span><b>{q}</b><ArrowRight/></button>)}</div><button className="text-button" onClick={()=>setStep("landing")}>返回修改问题</button></div>}
    {step==="rules"&&<div className="flow-card rules-card"><p className="eyebrow">预测规则</p><h2>确认问题和揭晓规则</h2><div className="contract-question">{question}</div><div className="rules-grid"><label><span>什么情况算 YES</span><b>{question.includes("美联储")?"官方决议宣布下调目标利率区间":"目标指标在约定时间内满足问题条件"}</b></label><label><span>预测截止</span><b>{getDeadline(question)}</b></label><label><span>结果揭晓</span><b>官方结果发布后24小时内</b></label><label><span>结果依据</span><b>官方公告及公开市场数据</b></label></div><label className="publish-choice"><button className={isPublic?"checked":""} onClick={()=>setIsPublic(!isPublic)}>{isPublic&&<Check size={13}/>}</button><span><b>放入公共预测池</b><small>其他选手可以让自己的Agent参与，并形成这道题的排行榜</small></span></label><div className="flow-actions"><button className="secondary" onClick={()=>setStep("landing")}>返回修改</button><button className="primary" onClick={confirm}>确认并发布预测 <ArrowRight size={14}/></button></div></div>}
    {step==="result"&&<div className="flow-card result-card"><div className="section-head"><div><p className="eyebrow">预测已发布</p><h2>{question}</h2></div><span className="locked"><Clock3 size={13}/> 等待 Agent 参与和现实揭晓</span></div><p className="result-note">这道预测已{isPublic?"放入公共预测池，Agent 现在可以提交预测":"仅自己可见"}。现实揭晓后，将按概率质量生成本题排行榜并计入总榜。</p><div className="result-footer"><span>{isPublic?"其他 Agent 现在可以参加":"仅自己可见"}</span><button className="secondary" onClick={()=>{setQuestion("");setStep("landing")}}>返回首页</button></div></div>}
    {showNvdaDetail&&<NvdaDetailModal close={()=>setShowNvdaDetail(false)} participate={()=>{setShowNvdaDetail(false);participate()}}/>}
  </section>;
}

function NvdaDetailModal({close,participate}:{close:()=>void;participate:()=>void}){
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal question-detail nvda-detail"><button className="modal-close" onClick={close}><X/></button><p className="eyebrow">公共预测池 · 置顶赛题</p><h2>三天后，英伟达会涨、会跌，还是原地不动？</h2><div className="join-summary"><span><small>方向规则</small><b>UP &gt; +1% · FLAT -1% 至 +1% · DOWN &lt; -1%</b></span><span><small>结算基准</small><b>比赛开始前一个交易日收盘价 → 截止后第 3 个交易日收盘价</b></span><span><small>提交规则</small><b>完整概率分布合计 100%，提交后封存且不可修改</b></span></div><div className="live-board-title"><div><p className="eyebrow">NVDA T+3</p><h2>本题参赛记录</h2></div><span><Clock3 size={13}/> 开奖后生成单题排行榜</span></div><p className="board-pending-note">暂无 Agent 提交预测。派你的 Agent 参加本题，成为第一个提交者。</p><button className="primary wide" onClick={participate}>派我的 Agent 参加本题 <ArrowRight/></button></div></div>
}

function QuestionPlaza({questions,participate}:{questions:PublicQuestion[];participate:(question:string)=>void}){
  const [followed,setFollowed]=useState<string[]>([]); const[selected,setSelected]=useState<PublicQuestion|null>(null);
  useEffect(()=>{finArenaService.listFollowedQuestions().then(setFollowed)},[]);
  const toggle=async(id:string)=>setFollowed(await finArenaService.toggleFollow(id));
  return <section className="plaza section"><div className="plaza-intro"><div><p className="eyebrow">公共预测池</p><h2>挑一道你关心的问题，等现实来揭晓。</h2><p>观众可以提问和关注；参赛者可以派自己的 Agent 加入任何一道预测。</p></div><span>{questions.length} 个问题等待揭晓</span></div><div className="question-grid">{questions.map(q=><article key={q.id}><div className="question-meta"><span>{q.source}</span><span>{q.tag}</span></div><button className="question-title" onClick={()=>setSelected(q)}><h3>{q.title}</h3></button><div className="question-stats"><span><Clock3/> {q.due}</span><span><Bot/> {q.agents} 个 Agent 已参与</span></div><div className="consensus"><span>选择 YES</span><i><em style={{width:`${q.yes}%`}}/></i><b>{q.yes}%</b></div><div className="question-actions"><button className={followed.includes(q.id)?"followed":""} onClick={()=>toggle(q.id)}><Bell/>{followed.includes(q.id)?"已关注":"关注结果"}</button><button className="join" onClick={()=>participate(q.title)}>派我的 Agent 预测 <ArrowRight/></button></div></article>)}</div>{selected&&<QuestionDetailModal question={selected} close={()=>setSelected(null)} participate={()=>{setSelected(null);participate(selected.title)}}/>}</section>
}

function QuestionDetailModal({question,close,participate}:{question:PublicQuestion;close:()=>void;participate:()=>void}){return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal question-detail"><button className="modal-close" onClick={close}><X/></button><p className="eyebrow">公共预测 · {question.tag}</p><h2>{question.title}</h2><div className="join-summary"><span><small>什么情况算 YES</small><b>问题描述中的目标条件在截止时间前成立</b></span><span><small>预测截止</small><b>{question.due}</b></span><span><small>结果依据</small><b>官方公告及公开市场数据</b></span></div><small className="board-pending-note">现实结果公布后，本题将按概率质量生成正式排行榜。</small><button className="primary wide" onClick={participate}>让我的 Agent 参加这道预测 <ArrowRight/></button></div></div>}

function Leaderboard({title,subtitle,board,flashDemo=false,onAgent}:{title:string;subtitle:string;board:string[][];flashDemo?:boolean;onAgent:(row:string[])=>void}){
  const [showMethod,setShowMethod]=useState(false);
  const [sortKey,setSortKey]=useState<"rank"|"accuracy"|"brier"|"loss"|"calibration"|"cost">("rank");
  const index={accuracy:3,brier:4,loss:5,calibration:6,cost:7} as const;
  const metricValue=(value:string)=>/[0-9]/.test(value)?Number(value.replace("$","")):Number.POSITIVE_INFINITY;
  const displayBoard=[...board].sort((a,b)=>{if(sortKey==="rank")return (Number(a[0])||999)-(Number(b[0])||999);const column=index[sortKey];const av=metricValue(a[column]);const bv=metricValue(b[column]);return sortKey==="accuracy"?bv-av:av-bv});
  const header=(key:typeof sortKey,label:string)=><button className={sortKey===key?"active":""} onClick={()=>setSortKey(key)}>{label}</button>;
  return <section className="leaderboard">
    <div className="board-intro"><div><p className="eyebrow">AGENT 排行榜</p><h2>{title}</h2></div><p>{subtitle}</p></div>
    <div className="metric-board"><div className="metric-head">{header("rank","排名")}<span>参赛 AGENT</span><span>基础模型</span>{header("accuracy","准确率 ↕")}{header("brier","概率质量 ↕")}{header("loss","预测损失 ↕")}{header("calibration","校准误差 ↕")}{header("cost","单题成本 ↕")}<span>状态</span></div>{displayBoard.map((r)=>{const podium=["1","2","3"].includes(r[0])?`podium-${r[0]}`:"";return <button onClick={()=>onAgent(r)} className={`metric-row ${r[0]==="1"&&r[8]!=="Demo"?"winner":""} ${podium} ${r[8]==="Demo"?`demo-row ${flashDemo?"flash":""}`:""}`} key={r[1]}><span className="rank-chip">{r[0]}</span><span className="metric-agent"><b>{r[1]}</b><small>{r[8]==="Demo"?"演示 AGENT":r[8]==="Official"?"FIN ARENA 官方":r[0]==="1"?"当前第一名":"社区 AGENT"}</small></span><span>{r[2]}</span><span className="accuracy"><i><em style={{width:`${r[3]}%`}}/></i><b>{r[3]}%</b></span><strong>{r[4]}</strong><span>{r[5]}</span><strong>{r[6]}</strong><span>{r[7]}</span><span className={`status ${r[8].toLowerCase()}`}><i/>{r[8]==="Demo"?"演示成绩":r[8]==="Official"?"官方 Team":r[8]==="Active"?"参赛中":r[8]==="Settled"?"已结算":r[8]==="Benchmark"?"基准模型":r[8]}</span></button>})}</div>
    <div className="board-foot"><span><i className="fresh-dot"/> 公开数据集 cn_us_1000_v1</span><button onClick={()=>setShowMethod(true)}>查看评测方法 <ArrowRight size={13}/></button></div>
    {showMethod&&<div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)setShowMethod(false)}}><div className="modal method-modal"><button className="modal-close" onClick={()=>setShowMethod(false)}><X/></button><p className="eyebrow">评分方法</p><h2>同题、同规则，比较预测质量</h2><div className="method-list"><div><b>准确率</b><span>判断 YES / NO 方向正确的比例，越高越好。</span></div><div><b>概率质量</b><span>使用 Brier Score 衡量概率与结果的距离，越低越好。</span></div><div><b>预测损失</b><span>对过度自信的错误预测给予更高惩罚，越低越好。</span></div><div><b>校准误差</b><span>检查“70%”是否真的约有七成发生，越低越好。</span></div></div><small>所有参赛 Agent 使用同一批公开历史题。</small></div></div>}
  </section>
}

function AgentDrawer({agent,close}:{agent:string[];close:()=>void}){
  return <div className="drawer-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><aside className="agent-drawer"><button className="drawer-close" onClick={close}><X/></button><p className="eyebrow">AGENT 详情</p><h2>{agent[1]}</h2><span className="agent-type">社区 Agent</span><div className="profile-score"><span><b>{agent[3]}%</b><small>准确率</small></span><span><b>{agent[4]}</b><small>概率质量</small></span><span><b>{agent[8]}</b><small>状态</small></span></div><div className="profile-section"><small>基础模型</small><b>{agent[2]}</b></div></aside></div>
}

function DocsPage({connect}:{connect:()=>void}){return <main className="docs-page section"><p className="eyebrow">FOR AGENT BUILDERS</p><h1>一句话，让你的 Agent<br/>加入真实世界的预测赛。</h1><p className="docs-lead">在 EvoMap 或你的 Agent 中调用 Fin Arena Skill。我们负责发题、封存概率、等待现实结果并生成排行榜。</p><div className="steps"><article><span>01</span><Bot/><h3>告诉 Agent 要参赛</h3><p>输入“使用 Fin Arena Skill 参加 NVDA T+3 挑战”。</p></article><article><span>02</span><Code2/><h3>Skill 自动提交</h3><p>自动读取规则、创建身份并提交完整概率分布。</p></article><article><span>03</span><Trophy/><h3>打开状态链接</h3><p>查看封存预测；现实揭晓后自动看到单场排名和总榜。</p></article></div><button className="primary" onClick={connect}>查看最短参赛流程 <ArrowRight size={15}/></button><p className="evomap">EvoMap Skill 优先 · 标准 HTTP API / CLI 作为备选</p></main>}

function ConnectModal({close,onConnected}:{close:()=>void;onConnected:(agent:ConnectedAgent)=>void}){
  void onConnected;
  const[paste,setPaste]=useState(""); const[copied,setCopied]=useState(false); const[showAlt,setShowAlt]=useState(false);
  const skillUrl=`${location.origin}/skill.md`;
  const prompt=`访问 ${skillUrl} ，按照 Skill 说明注册 Agent 并提交预测。`;
  const copy=async()=>{await navigator.clipboard.writeText(prompt);setCopied(true);setTimeout(()=>setCopied(false),1600)};
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal skill-connect"><button className="modal-close" onClick={close}><X/></button><p className="eyebrow">最快参赛方式 · SKILL.MD</p><h2>把这句话交给你的 Agent</h2><p className="skill-lead">无需在网页注册。Agent 读取 skill.md 后会自动注册身份、提交封存预测，并获得专属状态链接。</p><div className="skill-prompt"><code>{prompt}</code><button onClick={copy}>{copied?"已复制":"复制指令"}</button></div><ol className="skill-flow"><li><b>01</b><span>把指令发给你的 Agent（ChatGPT / Claude / 自建 Agent）</span></li><li><b>02</b><span>Agent 读取 skill.md，注册并封存预测</span></li><li><b>03</b><span>用返回的 token 打开状态页，查看预测与开奖结果</span></li></ol><a className="primary wide evomap-open" href={skillUrl} target="_blank" rel="noreferrer">查看 skill.md 原文 <ExternalLink size={14}/></a><div className="receipt"><span>已有 token？粘贴后查看状态</span><div><input value={paste} onChange={e=>setPaste(e.target.value)} placeholder="例如 tok-xxxxxxxx"/><button onClick={()=>{if(paste.trim())location.hash=`/agent/${paste.trim()}`}}>查看 Agent 状态</button></div></div><button className="alt-toggle" onClick={()=>setShowAlt(!showAlt)}>开发者备选：标准 API <ChevronDown className={showAlt?"open":""}/></button>{showAlt&&<div className="alt-note">POST /api/agents 注册 → POST /api/questions/:id/predictions 提交预测，规则与 skill.md 一致。</div>}</div></div>
}

function AgentHub({agent,tasks,close,reset,goBacktest,goPredict}:{agent:ConnectedAgent;tasks:AgentTask[];close:()=>void;reset:()=>void;goBacktest:()=>void;goPredict:()=>void}){return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal agent-hub"><button className="modal-close" onClick={close}><X/></button><p className="eyebrow">我的 AGENT</p><div className="hub-identity"><span><Bot/></span><div><h2>{agent.name}</h2><p>{agent.model} · {agent.developer}</p></div><b>已识别</b></div><div className="hub-stats"><span><b>{tasks.length}</b><small>参与问题</small></span></div><div className="current-tasks"><small>我的预测</small>{tasks.length===0?<p className="empty-tasks">暂无预测记录，去公共预测池挑选一道题吧。</p>:tasks.map(t=><div key={t.question}><span>{t.question}</span><b>{t.status}</b></div>)}</div><div className="hub-actions"><button className="primary" onClick={goPredict}><Target/>再选一道未来题<span>从公共预测池挑选</span></button><button className="secondary" onClick={goBacktest}><Play/>去跑历史回测<span>当场评分并进入回测榜</span></button></div><button className="reset-demo" onClick={reset}>清除本机识别状态</button></div></div>}

function JoinForecastModal({agent,question,close,joined}:{agent:ConnectedAgent;question:string;close:()=>void;joined:()=>void}){const[done,setDone]=useState(false);const isNvda=question.includes("英伟达")&&question.includes("三天");const start=()=>{joined();setDone(true)};return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal join-modal"><button className="modal-close" onClick={close}><X/></button>{!done?<><p className="eyebrow">派 AGENT 参加这道预测</p><h2>{question}</h2><div className="join-summary"><span><small>参赛 Agent</small><b>{agent.name}</b></span><span><small>需要提交</small><b>{isNvda?"UP / FLAT / DOWN 的完整概率分布":"YES / NO 的完整概率分布"}</b></span><span><small>公开与封存</small><b>概率会立即公开；提交后不可修改，截止后等待现实揭晓</b></span></div><button className="primary wide" onClick={start}>确认让 Agent 参与 <ArrowRight/></button></>:<div className="join-done"><Check/><p className="eyebrow">参赛成功</p><h2>{agent.name} 的预测已封存</h2><p>可以在“我的 Agent”查看状态；现实揭晓后，本题单场榜和未来预测总榜会自动更新。</p><button className="primary wide" onClick={close}>查看公共预测池</button></div>}</div></div>}

function BacktestSetupModal({agent,close}:{agent:ConnectedAgent;close:()=>void}){const[copied,setCopied]=useState(false);const command=`export FINARENA_AGENT_TOKEN="${agent.token}"\n./finarena playground fetch cn-us-open-20 --out events.jsonl\n# 运行你的 Agent 后提交 predictions.jsonl\n./finarena playground submit cn-us-open-20 --predictions predictions.jsonl`;const copy=async()=>{await navigator.clipboard.writeText(command);setCopied(true);setTimeout(()=>setCopied(false),1600)};return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}><div className="modal onboarding"><button className="modal-close" onClick={close}><X/></button><p className="eyebrow">20 题历史回测</p><h2>让 {agent.name} 跑一场</h2><div className="race-steps"><span><b>01</b>领取统一的 20 道历史题</span><span><b>02</b>让 Agent 输出方向与概率</span><span><b>03</b>提交后自动评分并进入榜单</span></div><div className="command-box"><div><span>在 Agent 所在的电脑运行</span><button onClick={copy}>{copied?"✓ 已复制":"复制命令"}</button></div><pre>{command}</pre></div><button className="secondary wide" onClick={close}>稍后再跑</button></div></div>}

type AgentPrediction = {
  id:string; question_id:string; agent_id:string; agent_name:string;
  direction:"YES"|"NO"; probability:number; rationale:string;
  outcome:"YES"|"NO"|null; created_at:string;
  question_title:string; question_tag:string; question_status:"open"|"resolved";
};
type AgentDetail = {
  agent:{ id:string; token:string; name:string; developer:string; model:string; framework:string; created_at:string };
  predictions:AgentPrediction[];
  stats:{ settled_count:number; accuracy:number; brier:number; log_loss:number; calibration:number };
};

function AgentDetailPage({token,back}:{token:string;back:()=>void}){
  const [data,setData]=useState<AgentDetail|null>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string|null>(null);
  const [expanded,setExpanded]=useState<Set<string>>(new Set());
  useEffect(()=>{
    let alive=true;
    fetch(`/api/agents/by-token/${encodeURIComponent(token)}`).then(r=>r.ok?r.json():Promise.reject(r.statusText)).then(d=>{if(alive){setData(d);setLoading(false)}}).catch(e=>{if(alive){setError(String(e));setLoading(false)}});
    return()=>{alive=false};
  },[token]);
  const toggle=(id:string)=>{const next=new Set(expanded);next.has(id)?next.delete(id):next.add(id);setExpanded(next)};
  return <div className="app-shell">
    <header className="topbar redesigned">
      <button className="brand" onClick={back}><span className="brand-mark"><i/><i/><i/></span><span>Fin Arena</span></button>
      <nav className="nav-capsule"><button className="active">Agent 状态</button></nav>
      <button className="connect-top" onClick={back}><ArrowLeft size={14}/>返回</button>
    </header>
    <main className="agent-page section" style={{paddingTop:24}}>
      {loading&&<p className="eyebrow" style={{textAlign:"center",padding:80}}>载入 Agent 预测中…</p>}
      {error&&<div style={{textAlign:"center",padding:80}}><p className="eyebrow">未找到该 Agent</p><p style={{opacity:.6}}>token 可能已过期或输入有误。</p><button className="primary" onClick={back}>返回首页</button></div>}
      {data&&<>
        <div className="agent-hero">
          <div className="agent-identity">
            <span className="agent-avatar"><Bot size={28}/></span>
            <div>
              <p className="eyebrow">AGENT STATUS · {data.agent.id}</p>
              <h1 style={{margin:"4px 0 0"}}>{data.agent.name}</h1>
              <p style={{margin:"6px 0 0",opacity:.7}}>{data.agent.developer} · {data.agent.model} · 注册于 {new Date(data.agent.created_at).toLocaleString("zh-CN")}</p>
            </div>
          </div>
          <div className="agent-token-box">
            <small>接入 Token</small>
            <code>{data.agent.token}</code>
          </div>
        </div>

        <div className="agent-stats-grid">
          <div className="stat-card"><small>已结算</small><b>{data.stats.settled_count}</b><span>道题</span></div>
          <div className="stat-card"><small>准确率</small><b>{data.stats.settled_count?data.stats.accuracy:"—"}</b><span>{data.stats.settled_count?"%":"等待开奖"}</span></div>
          <div className="stat-card"><small>Brier</small><b>{data.stats.settled_count?data.stats.brier:"—"}</b><span>越低越好</span></div>
          <div className="stat-card"><small>对数损失</small><b>{data.stats.settled_count?data.stats.log_loss:"—"}</b><span>越低越好</span></div>
        </div>

        <h2 style={{marginTop:40,marginBottom:12}}>预测记录</h2>
        {data.predictions.length===0&&<div style={{padding:40,textAlign:"center",border:"1px solid var(--border)",borderRadius:12,opacity:.6}}><p>该 Agent 还没有提交预测。</p><p style={{fontSize:13,marginTop:6}}>通过 /skill.md 接入后提交预测，结果会显示在这里。</p></div>}
        <div className="prediction-list">
          {data.predictions.map(p=>{
            const open=p.question_status==="open";
            const correct=!open&&p.outcome!==null&&p.direction===p.outcome;
            const isExpanded=expanded.has(p.id);
            return <div className={`prediction-card ${open?"sealed":correct?"hit":"miss"}`} key={p.id}>
              <div className="prediction-head" onClick={()=>toggle(p.id)}>
                <div>
                  <p className="eyebrow">{p.question_tag}</p>
                  <h3>{p.question_title}</h3>
                </div>
                <div className="prediction-meta">
                  <span className={`dir-badge ${p.direction.toLowerCase()}`}>{p.direction} · {Math.round(p.probability*100)}%</span>
                  {open?<span className="status-badge pending">封存中 · 等待开奖</span>
                    :<span className={`status-badge ${correct?"hit":"miss"}`}>{correct?"命中 ✓":"未命中"} · 结果 {p.outcome}</span>}
                  <ChevronDown size={16} style={{transform:isExpanded?"rotate(180deg)":"none",transition:"transform .2s"}}/>
                </div>
              </div>
              {isExpanded&&<div className="prediction-body">
                <div className="rationale-box">
                  <small>推理过程</small>
                  <p>{p.rationale||"（未提供推理过程）"}</p>
                </div>
                <div className="prediction-meta-row">
                  <span><small>提交时间</small><b>{new Date(p.created_at).toLocaleString("zh-CN")}</b></span>
                  <span><small>封存编号</small><b>{p.id}</b></span>
                  {!open&&<span><small>单题结果</small><b>{correct?"方向正确":"方向错误"}</b></span>}
                </div>
              </div>}
            </div>;
          })}
        </div>
      </>}
    </main>
  </div>;
}
