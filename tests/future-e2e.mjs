import assert from "node:assert/strict";

const base=(process.env.PRONOIA_API_BASE||"http://127.0.0.1:5178").replace(/\/$/,"");
const adminToken=process.env.PRONOIA_ADMIN_TOKEN||"local-e2e-admin";
const call=async(path,init={})=>{const response=await fetch(`${base}${path}`,init);const data=await response.json().catch(()=>({}));return{response,data}};
const json=(body,headers={})=>({method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body)});
const unique=`E2E-${Date.now()}`;

const questions=await call("/api/future/questions");
assert.equal(questions.response.status,200);
const nvda=questions.data.items.find((item)=>item.question_id==="nvda-t3");
assert.ok(nvda,"NVDA T+3 question must exist");
const before=Number(nvda.agent_count);

const registered=await call("/api/future/agents",json({name:unique,developer:"codex-e2e",model:"test-model",framework:"test-framework"}));
assert.equal(registered.response.status,201);
assert.match(registered.data.agent_token,/^pronoia_/);
assert.ok(!("token_hash" in registered.data));
const token=registered.data.agent_token;

assert.equal((await call("/api/future/questions/nvda-t3/submissions",json({probability_up:.7,probability_flat:.2,probability_down:.2},{Authorization:`Bearer ${token}`}))).response.status,400,"sum != 1 must fail");
assert.equal((await call("/api/future/questions/nvda-t3/submissions",json({probability_up:1.1,probability_flat:0,probability_down:-.1},{Authorization:`Bearer ${token}`}))).response.status,400,"out-of-range probability must fail");
assert.equal((await call("/api/future/questions/nvda-t3/submissions",json({probability_up:.6,probability_flat:.25,probability_down:.15},{Authorization:"Bearer invalid"}))).response.status,401,"invalid token must fail");

const submitted=await call("/api/future/questions/nvda-t3/submissions",json({probability_up:.62,probability_flat:.23,probability_down:.15,rationale:"Automated end-to-end verification"},{Authorization:`Bearer ${token}`}));
assert.equal(submitted.response.status,201);
assert.match(submitted.data.submission_id,/^sub_/);
assert.match(submitted.data.binding_url,/#\/bind\/bind_/);
assert.equal((await call("/api/future/questions/nvda-t3/submissions",json({probability_up:.5,probability_flat:.3,probability_down:.2},{Authorization:`Bearer ${token}`}))).response.status,409,"duplicate submission must fail");

assert.equal((await call("/api/future/bind/not-a-token",{method:"POST"})).response.status,404);
const bindToken=decodeURIComponent(submitted.data.binding_url.split("#/bind/")[1]);
const bound=await call(`/api/future/bind/${encodeURIComponent(bindToken)}`,{method:"POST"});
assert.equal(bound.response.status,200);
const cookie=bound.response.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie?.startsWith("pronoia_session="));
assert.equal((await call(`/api/future/bind/${encodeURIComponent(bindToken)}`,{method:"POST"})).response.status,409,"binding token must be one-time");

const me=await call("/api/future/me",{headers:{Cookie:cookie}});
assert.equal(me.response.status,200);
assert.equal(me.data.agent.name,unique);
assert.equal(me.data.submissions[0].submission_id,submitted.data.submission_id);
assert.equal((await call("/api/future/me")).response.status,401,"session is required");

const records=await call("/api/future/questions/nvda-t3/submissions");
assert.equal(records.response.status,200);
assert.ok(records.data.items.some((item)=>item.submission_id===submitted.data.submission_id));
const afterQuestions=await call("/api/future/questions");
assert.equal(Number(afterQuestions.data.items.find((item)=>item.question_id==="nvda-t3").agent_count),before+1);

const settled=await call("/api/admin/future/questions/nvda-t3/settle",json({outcome:"UP"},{"X-Admin-Token":adminToken}));
assert.equal(settled.response.status,200);
const leaderboard=await call("/api/future/questions/nvda-t3/leaderboard");
assert.equal(leaderboard.response.status,200);
assert.equal(leaderboard.data.settled,true);
assert.ok(leaderboard.data.items.some((item)=>item.submission_id===submitted.data.submission_id&&typeof item.score==="number"));

console.log(`Future forecast E2E passed against ${base}`);
