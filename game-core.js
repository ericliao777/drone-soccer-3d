'use strict';
/* =========================================================
   無人機足球・十大術科訓練場 — 共用核心
   狀態 / 物理 / 任務邏輯 / 進度保存 / 排行榜
   渲染由 render3d.js 負責；本檔的任務 draw(R) 只發出
   顯示指令（display list），與畫面實作解耦。
   輸入由各頁面（keyboard / gamepad）提供 window.readInput()。
   ========================================================= */
const $ = id => document.getElementById(id);
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const TAU = Math.PI*2;
const fmt1 = v=>v.toFixed(1), fmt2 = v=>v.toFixed(2);

/* ---------- persistent progress (per-player) ---------- */
const SAVE_KEY='droneSoccerCampV2';
let save = {players:{}, current:'', teacher:false};
try{
  const s=localStorage.getItem(SAVE_KEY);
  if(s){ save=Object.assign(save,JSON.parse(s)); }
  else{
    const old=localStorage.getItem('droneSoccerCampV1');   // 舊版(單人)進度搬移
    if(old){
      const o=JSON.parse(old);
      save.teacher=!!o.teacher;
      if(o.stars && Object.keys(o.stars).length){
        save.players['學員1']={stars:o.stars, results:{}};
        save.current='學員1';
      }
    }
  }
}catch(e){}
if(!save.players) save.players={};
function persist(){ try{localStorage.setItem(SAVE_KEY,JSON.stringify(save));}catch(e){} }
function P(){ return (save.current&&save.players[save.current])||null; }
function ensurePlayer(){
  if(P()) return P();
  save.players['訪客']=save.players['訪客']||{stars:{},results:{}};
  save.current='訪客';
  return P();
}

/* ---------- drone state ---------- */
const drone = {x:0,y:0,z:0,vx:0,vy:0,vz:0,hdg:0,motors:true,rot:0};
const stick = {thr:0,yaw:0,pitch:0,roll:0};

const world = {half:2.7};       // arena ±2.7 m
let scene='menu';               // menu | brief | play | done
let mi=0, M=null;               // current mission index/object
let t=0, started=false, faults=0;
let warnUntil=0, warnAcc=0;
let windPhase=Math.random()*10;
let touchdown={t:-9,vz:0,justLanded:false};
let cutAt=-9;
let altBand=null;               // HUD 高度帶（由 R.altBand 設定）

/* =========================================================
   R — 顯示指令清單（display list）
   任務的 draw(R) 每幀重新發出指令，由渲染器消化。
   座標皆為場地世界座標（公尺，x 東+ / y 北+ / z 上+）。
   ========================================================= */
const R={
  list:[],
  begin(){ this.list.length=0; },
  pad(x,y,alpha){ this.list.push({t:'pad',x,y,alpha:alpha===undefined?1:alpha}); },
  ring(x,y,r,color){ this.list.push({t:'ring',x,y,r,color}); },
  arc(x,y,r,f,color){ this.list.push({t:'arc',x,y,r,f:clamp(f,0,1),color}); },
  ray(ang,color){ this.list.push({t:'ray',ang,color}); },          // 從機身出發的目標方向虛線
  corridor(dir,w){ this.list.push({t:'corridor',dir,w}); },        // dir:'v'|'h'
  square(half,color){ this.list.push({t:'square',half,color}); },  // 原點為中心的虛線正方形
  ellipse(cx,cy,rx,ry,color){ this.list.push({t:'ellipse',cx,cy,rx,ry,color}); },
  zoneRect(cx,cy,w,h,opts){ this.list.push(Object.assign({t:'zoneRect',cx,cy,w,h},opts||{})); },
  line(x1,y1,x2,y2,color,opts){ this.list.push(Object.assign({t:'line',x1,y1,x2,y2,color},opts||{})); },
  text(x,y,txt,color){ this.list.push({t:'text',x,y,txt,color}); },
  pylon(x,y){ this.list.push({t:'pylon',x,y}); },
  goal(y){ this.list.push({t:'goal',y}); },                        // 球門（x -0.8..0.8）
  padColor(x,y,color,state,label){ this.list.push({t:'padColor',x,y,color,state,label}); }, // 彩色降落墊
  ball(x,y,z,live,zOk){ this.list.push({t:'ball',x,y,z,live,zOk}); },
  altBand(a,b,shuttle){ altBand={a,b,shuttle:!!shuttle}; }
};

/* =========================================================
   MISSIONS — 規格取自指南
   ========================================================= */
const missions=[
/* ---- STAGE 1 ---- */
{
  id:1, stage:1, name:'起飛與定點懸停', skill:'起飛、懸停與四方位旋轉(上)',
  goal:'起飛至 1.0–1.6m 高度,停在中央圓圈(半徑 50cm)內,連續懸停 10 秒。飄出圈外或高度跑掉,計時歸零重來。',
  keys:'只用<b>左桿油門(W/S)</b>控制高度,<b>右桿</b>微調位置。桿量要小、要柔。',
  coach:'<b>穩住呼吸。</b>懸停是所有術科的地基——油門不是開關,是「呼吸」。看到飄移,提早半秒給一點點反向桿,而不是等飄出去才大桿救。標準:半徑 50cm 內持續 10 秒。',
  par:26, wind:0.22,
  steps:['起飛,爬升到 1.0–1.6m','進入中央圓圈','連續懸停 10 秒'],
  st:{hold:0},
  setup(){ this.st={hold:0}; },
  update(dt){
    const s=this.st, inBand=drone.z>=1.0&&drone.z<=1.6, inCir=Math.hypot(drone.x,drone.y)<=0.5;
    setStep(0, drone.z>=1.0);
    setStep(1, inBand&&inCir);
    if(drone.z>0.2&&inBand&&inCir){ s.hold+=dt; }
    else if(s.hold>0&&drone.z>0.2){ if(s.hold>1) flashWarn('跳出範圍,計時歸零!'); s.hold=0; }
    setStep(2, s.hold>=10);
    liveGoal(`連續懸停 <b style="color:var(--hud)">${fmt1(Math.min(10,s.hold))}</b> / 10.0 秒`);
    if(s.hold>=10) return true;
  },
  draw(R){
    R.pad(0,0);
    R.ring(0,0,0.5, this.st.hold>0?'rgba(79,227,163,.9)':'rgba(79,227,163,.45)');
    if(this.st.hold>0) R.arc(0,0,0.62,this.st.hold/10,'#4fe3a3');
    R.altBand(1.0,1.6);
  }
},
{
  id:2, stage:1, name:'四方位旋轉', skill:'起飛、懸停與四方位旋轉(下)',
  goal:'在中央圓圈內懸停,依序把機頭轉向 右(90°)→ 後(180°)→ 左(270°)→ 前(0°),每個方位穩定停留 3 秒。',
  keys:'<b>左桿 A/D</b> 控制旋轉。轉到位就鬆桿,盯著機頭橘色箭頭對準指南針目標。',
  coach:'<b>每 90° 精準停頓。</b>旋轉時多數新手會同時掉高度——記得 Yaw 打桿時,油門要跟著補一點。轉過頭比轉不到更常見:提早收桿,讓機頭「滑」進目標角度。',
  par:36, wind:0.2,
  steps:['懸停於中央圓圈','機頭向右 90°,停 3 秒','機頭向後 180°,停 3 秒','機頭向左 270°,停 3 秒','機頭回正 0°,停 3 秒'],
  st:{i:0,hold:0},
  setup(){ this.st={i:0,hold:0}; },
  update(dt){
    const s=this.st, targets=[90,180,270,0];
    const inCir=Math.hypot(drone.x,drone.y)<=0.5 && drone.z>0.5;
    setStep(0,inCir);
    if(s.i<4){
      const tgt=targets[s.i];
      let d=Math.abs(((drone.hdg*180/Math.PI - tgt)%360+540)%360-180);
      if(inCir && d<=12){ s.hold+=dt; } else s.hold=0;
      if(s.hold>=3){ setStep(1+s.i,true); s.i++; s.hold=0; ping(); }
      liveGoal(`目標機頭:<b style="color:var(--accent)">${['右 90°','後 180°','左 270°','前 0°'][Math.min(s.i,3)]}</b>・穩定 ${fmt1(Math.min(3,s.hold))} / 3.0 秒`);
    }
    if(s.i>=4) return true;
  },
  draw(R){
    R.pad(0,0);
    R.ring(0,0,0.5,'rgba(79,227,163,.5)');
    const targets=[90,180,270,0], s=this.st;
    if(s.i<4){
      const a=targets[s.i]*Math.PI/180;
      R.ray(a,'#ff8a3c');
      if(s.hold>0) R.arc(0,0,0.62,s.hold/3,'#ff8a3c');
    }
    R.altBand(0.6,2.2);
  }
},
{
  id:3, stage:1, name:'前後飛行控制', skill:'前後與左右側飛控制',
  goal:'保持機頭朝前,沿走廊「前推 → 後拉」:飛進北環停 2 秒,再倒退回南環停 2 秒。偏出走廊(左右 ±35cm)會記失誤。',
  keys:'只用<b>右桿 ↑/↓</b>。倒退時不要轉頭!練的就是非機頭指向的移動。',
  coach:'<b>航跡不偏移。</b>前後飛看似簡單,難在「回程」——倒退時視覺是反的,新手容易愈修愈歪。訣竅:眼睛盯航線不盯機身,桿量給小,讓機體自己滑。',
  par:30, wind:0.24,
  steps:['起飛,進入走廊','前推至北環,停 2 秒','後拉回南環,停 2 秒'],
  st:{i:0,hold:0},
  setup(){ this.st={i:0,hold:0}; drone.y=-1.8; },
  update(dt){
    const s=this.st;
    setStep(0, drone.z>0.5);
    corridorCheck(dt, Math.abs(drone.x)>0.35 && drone.z>0.4, '偏出走廊!');
    const rings=[{x:0,y:1.8},{x:0,y:-1.8}];
    if(s.i<2){
      const r=rings[s.i];
      if(drone.z>0.4 && Math.hypot(drone.x-r.x,drone.y-r.y)<=0.35) s.hold+=dt; else s.hold=0;
      if(s.hold>=2){ setStep(1+s.i,true); s.i++; s.hold=0; ping(); }
      liveGoal(`${s.i===0?'前推至北環':'後拉回南環'}・停留 ${fmt1(Math.min(2,s.hold))} / 2.0 秒`);
    }
    if(s.i>=2) return true;
  },
  draw(R){
    R.corridor('v',0.35);
    R.pad(0,-1.8);
    R.ring(0,1.8,0.35, this.st.i===0?'#ff8a3c':'rgba(79,227,163,.9)');
    R.ring(0,-1.8,0.35, this.st.i===1?'#ff8a3c':'rgba(79,227,163,.5)');
  }
},
{
  id:4, stage:1, name:'左右側飛控制', skill:'前後與左右側飛控制',
  goal:'側飛=整台機體往左右「平移」滑動。向右側飛到右邊的環停 2 秒,再向左側飛回左邊的環停 2 秒。',
  keys:'用<b>右桿 ←/→</b> 讓機體左右移動,穩穩停進圈裡就好。',
  coach:'<b>熟悉左右平移的手感。</b>側飛是無人機足球的看家本領——先把「機體往左右滑」練順,在兩個環之間穩穩來回,推桿別太猛以免滑過頭。',
  par:30, wind:0.24,
  steps:['起飛','向右側飛到右環,停 2 秒','向左側飛回左環,停 2 秒'],
  st:{i:0,hold:0},
  setup(){ this.st={i:0,hold:0}; drone.x=-1.8; },
  update(dt){
    const s=this.st;
    setStep(0, drone.z>0.5);
    const rings=[{x:1.8,y:0},{x:-1.8,y:0}];
    if(s.i<2){
      const r=rings[s.i];
      if(drone.z>0.4 && Math.hypot(drone.x-r.x,drone.y-r.y)<=0.35) s.hold+=dt; else s.hold=0;
      if(s.hold>=2){ setStep(1+s.i,true); s.i++; s.hold=0; ping(); }
      liveGoal(`${s.i===0?'向右側飛到右環':'向左側飛回左環'}・停留 ${fmt1(Math.min(2,s.hold))} / 2.0 秒`);
    }
    if(s.i>=2) return true;
  },
  draw(R){
    R.corridor('h',0.35);
    R.pad(-1.8,0);
    R.ring(1.8,0,0.35, this.st.i===0?'#ff8a3c':'rgba(79,227,163,.9)');
    R.ring(-1.8,0,0.35, this.st.i===1?'#ff8a3c':'rgba(79,227,163,.5)');
  }
},
{
  id:5, stage:1, name:'定高巡航', skill:'穩定性標準:高度誤差 < 20cm',
  goal:'把高度鎖在 1.2m(±20cm),沿走廊完成北環→南環一趟來回。高度跑出綠色帶超過 1 秒記一次失誤。',
  keys:'眼睛一半看場地、一半看右側<b>高度尺</b>。油門微調,不可大幅起伏。',
  coach:'<b>保持高度穩定,不可產生大幅起伏。</b>移動時機體會自然掉高——前推的同時油門加一絲。這一關練的是「雙桿同時、各自獨立」,是第二階段所有航路的門票。',
  par:32, wind:0.26,
  steps:['爬升進入 1.2m ±20cm 高度帶','鎖定高度前往北環','鎖定高度返回南環'],
  st:{i:0,out:0},
  setup(){ this.st={i:0,out:0}; drone.y=-1.8; },
  update(dt){
    const s=this.st, inBand=drone.z>=1.0&&drone.z<=1.4;
    setStep(0, inBand);
    if(drone.z>0.5 && started){
      if(!inBand){ s.out+=dt; if(s.out>=1){ addFault('高度誤差超過 20cm!'); s.out=0; } }
      else s.out=0;
    }
    const rings=[{x:0,y:1.8},{x:0,y:-1.8}];
    if(s.i<2){
      const r=rings[s.i];
      if(Math.hypot(drone.x-r.x,drone.y-r.y)<=0.35 && inBand){ setStep(1+s.i,true); s.i++; ping(); }
      liveGoal(`高度 <b style="color:${inBand?'var(--hud)':'var(--warn)'}">${fmt2(drone.z)}m</b>(目標 1.00–1.40m)・${s.i===0?'前往北環':'返回南環'}`);
    }
    if(s.i>=2) return true;
  },
  draw(R){
    R.corridor('v',0.45);
    R.pad(0,-1.8);
    R.ring(0,1.8,0.35, this.st.i===0?'#ff8a3c':'rgba(79,227,163,.9)');
    R.ring(0,-1.8,0.35, this.st.i===1?'#ff8a3c':'rgba(79,227,163,.5)');
    R.altBand(1.0,1.4);
  }
},
/* ---- STAGE 2 ---- */
{
  id:6, stage:2, name:'2×2m 正方形航路', skill:'正方形航路(4 次旋轉)',
  goal:'依序通過四個角點環(西南→西北→東北→東南→回西南),沿正方形邊線飛行。每到一個角點都要「原地把機頭旋轉 90°」對準下一段方向才能前進,回到西南角後再把機頭轉回正前方——全程共 4 次旋轉,少一次都不算過關。偏離邊線太遠會記失誤。',
  keys:'每個角:<b>減速停住 → 左桿把機頭轉 90° → 再前進</b>。左桿 A/D 轉機頭,右桿前推。',
  coach:'<b>機頭跟著走位轉,四個角=四次旋轉。</b>每一段方向都不同:先轉向、再推進,四次 90° 剛好轉滿一圈 360°。角點要「方」——直線給桿、進角收桿,飛圓角代表你桿收太晚。',
  par:48, wind:0.28,
  steps:['起飛,機頭朝前 ↑','直飛西北角 ①','旋轉 90° → 東北角 ②','旋轉 90° → 東南角 ③','旋轉 90° → 回西南角 ④','第 4 次旋轉:機頭轉回前 ↑,穩住 1 秒'],
  st:{i:0,rot:0,aligned:true,hold:0},
  setup(){ this.st={i:0,rot:0,aligned:true,hold:0}; drone.x=-1; drone.y=-1; },
  update(dt){
    const s=this.st, pts=[[-1,1],[1,1],[1,-1],[-1,-1]];
    const DIRS=['前↑','右→','後↓','左←'];
    setStep(0, drone.z>0.5);
    const reqDeg=(s.i<4?s.i:0)*90;
    const cur=((drone.hdg*180/Math.PI)%360+360)%360;
    const hd=Math.abs(((cur-reqDeg)%360+540)%360-180);
    // corridor: nearest point on square edges
    if(drone.z>0.4){
      const dEdge=distToSquare(drone.x,drone.y,1);
      corridorCheck(dt, dEdge>0.4, '偏離航路!');
    }
    if(s.i<4){
      const p=pts[s.i];
      if(!s.aligned){
        // 剛過角點:必須在角點附近原地旋轉 90° 對準下一段
        const c=pts[s.i-1];
        const atCorner=Math.hypot(drone.x-c[0],drone.y-c[1])<=0.6;
        if(hd<=20 && atCorner){ s.aligned=true; s.rot++; ping(1150); }
        else{
          if(drone.z>0.4 && !atCorner) flashWarn('回到角點,先把機頭轉到位再前進!');
          liveGoal(`第 <b style="color:var(--accent)">${s.rot+1} / 4</b> 次旋轉:在角點把機頭轉到 <b>${DIRS[s.i]}</b>(偏差 ${hd.toFixed(0)}°)`);
          return;
        }
      }
      if(drone.z>0.4 && Math.hypot(drone.x-p[0],drone.y-p[1])<=0.35 && hd<=20){
        setStep(1+s.i,true); s.i++; if(s.i<4) s.aligned=false; ping();
      }
      if(s.i<4 && s.aligned) liveGoal(`旋轉 <b style="color:var(--hud)">${s.rot} / 4</b>・機頭保持 <b>${DIRS[s.i]}</b>,飛往 <b style="color:var(--accent)">${['西北 ↖','東北 ↗','東南 ↘','西南 ↙'][s.i]}</b>(偏差 ${hd.toFixed(0)}°)`);
    }
    if(s.i>=4){
      // 第 4 次旋轉:回到西南角後,機頭轉回正前方並穩住 1 秒
      const atSW=Math.hypot(drone.x+1,drone.y+1)<=0.6;
      if(drone.z>0.4 && atSW && hd<=15) s.hold+=dt; else s.hold=0;
      if(s.hold>=1){ s.rot=4; setStep(5,true); return true; }
      liveGoal(`第 <b style="color:var(--accent)">4 / 4</b> 次旋轉:在西南角把機頭轉回 <b>前↑</b>(偏差 ${hd.toFixed(0)}°)・穩住 ${fmt1(Math.min(1,s.hold))} / 1.0 秒`);
    }
  },
  draw(R){
    R.square(1,'rgba(255,138,60,.4)');
    const pts=[[-1,1],[1,1],[1,-1],[-1,-1]], s=this.st;
    R.pad(-1,-1);
    for(let k=0;k<4;k++){
      const done=k<s.i, cur=k===s.i;
      R.ring(pts[k][0],pts[k][1],0.32, done?'rgba(79,227,163,.9)':cur?'#ff8a3c':'rgba(140,163,184,.35)');
      R.text(pts[k][0],pts[k][1]+0.5,String(k+1), cur?'#ff8a3c':'#5c7186');
    }
    R.ray((s.i<4?s.i:0)*Math.PI/2,'#ff8a3c');
    if(s.i<4 && !s.aligned) R.text(pts[s.i-1][0],pts[s.i-1][1]-0.5,'⟳ 原地轉 90°','#ff8a3c');
    if(s.i>=4){ R.ring(-1,-1,0.32,'#ff8a3c'); R.text(-1,-1.5,'⟳ 轉回前↑','#ff8a3c'); }
    R.text(0,0,`旋轉 ${s.rot} / 4`,'rgba(140,163,184,.9)');
  }
},
{
  id:7, stage:2, name:'模擬進球急停', skill:'反向撥桿急停',
  goal:'從南端全速衝刺,以 ≥2.0 m/s 的速度衝過球門線,然後用反向撥桿在煞車區(線後 70cm)內完全停住。衝太慢或衝出界都要重跑。',
  keys:'衝刺:<b>↑ 推到底</b>。過線瞬間<b>↓ 反打到底</b>再回中。這就是「反向撥桿急停」。',
  coach:'<b>射門靠衝刺,得分靠急停。</b>真正的比賽裡,穿過球門後撞牆=犯規。反向桿的時機是體感:過線「前」一點點就要開始反打,因為機體有慣性。停得愈短,你就愈接近選手。',
  par:22, wind:0.2, acc:1.5,
  steps:['起飛,回到南端起跑區','全速衝刺,過線速度 ≥ 2.0 m/s','在煞車區內完全停住'],
  st:{phase:0,crossSpd:0},
  setup(){ this.st={phase:0,crossSpd:0}; drone.y=-2.1; },
  update(dt){
    const s=this.st, LINE=1.3, ZONE=0.7;
    const spd=Math.hypot(drone.vx,drone.vy);
    setStep(0, drone.z>0.5);
    if(s.phase===0){
      if(drone.z>0.4 && drone.y>=LINE){
        if(spd>=2.0){ s.phase=1; s.crossSpd=spd; setStep(1,true); ping(); }
        else{ addFault(`過線太慢 ${fmt1(spd)} m/s(需 ≥2.0)`); resetRun(); }
      }
      liveGoal(`衝刺速度 <b style="color:${spd>=2.0?'var(--hud)':'var(--accent)'}">${fmt1(spd)}</b> m/s(過線需 ≥ 2.0)`);
    } else if(s.phase===1){
      if(drone.y>LINE+ZONE){ addFault('衝出煞車區!'); s.phase=0; resetRun(); setStep(1,false); }
      else if(spd<=0.15){ setStep(2,true); return true; }
      liveGoal(`反向撥桿!剩餘 <b style="color:var(--warn)">${Math.max(0,(LINE+ZONE-drone.y)*100).toFixed(0)}cm</b>・速度 ${fmt1(spd)} m/s`);
    }
    function resetRun(){ drone.x=0; drone.y=-2.1; drone.vx=drone.vy=0; }
  },
  draw(R){
    const LINE=1.3, ZONE=0.7;
    // runway
    R.zoneRect(0,-0.55,1.2,3.7,{stroke:'rgba(79,168,255,.25)'});
    // brake zone
    R.zoneRect(0,LINE+ZONE/2,1.2,ZONE,{fill:'rgba(255,92,92,.12)'});
    R.line(-0.6,LINE,0.6,LINE,'#ff8a3c',{width:4});
    R.line(-0.6,LINE+ZONE,0.6,LINE+ZONE,'rgba(255,92,92,.8)',{dash:true,width:3});
    R.text(0,LINE+0.18,'球門線','#ff8a3c');
    R.text(0,LINE+ZONE+0.18,'煞車底線','#ff5c5c');
    R.pad(0,-2.1);
    R.goal(LINE+ZONE+0.15);
  }
},
{
  id:8, stage:2, name:'「8」字協調飛行', skill:'同時協調使用旋轉(Yaw)與側飛(Roll)',
  goal:'繞兩支標桿飛出一個 8 字:依序通過 8 個檢查點。試著同時協調 Yaw 與 Roll,讓航跡圓滑。',
  keys:'左手<b>持續給一點 Yaw</b>、右手<b>同步給 Roll + Pitch</b>,雙桿一起動,轉彎才會滑順。',
  coach:'<b>雙桿協調是分水嶺。</b>能把 8 字飛圓,代表左右手已經「解耦」——這是繞樁、過人、盤球的共同底層。飛歪了別急著修,先把速度放慢,協調感比速度重要。',
  par:48, wind:0.26,
  steps:['起飛,通過檢查點 1','完成右圈(點 1–4)','穿越中心交叉','完成左圈(點 5–8)'],
  st:{i:0},
  setup(){ this.st={i:0}; drone.y=0; drone.x=0; },
  update(dt){
    const s=this.st, pts=this.pts;
    if(s.i<pts.length){
      const p=pts[s.i];
      if(drone.z>0.4 && Math.hypot(drone.x-p[0],drone.y-p[1])<=0.32){ s.i++; ping(); }
      liveGoal(`檢查點 <b style="color:var(--purple)">${s.i} / ${pts.length}</b>`);
    }
    setStep(0,s.i>=1); setStep(1,s.i>=4); setStep(2,s.i>=5); setStep(3,s.i>=8);
    if(s.i>=pts.length) return true;
  },
  pts:[[0.9,0.75],[1.7,0],[0.9,-0.75],[0,0],[-0.9,0.75],[-1.7,0],[-0.9,-0.75],[0,0]],
  draw(R){
    // figure-8 guide
    R.ellipse(0.9,0,0.85,0.8,'rgba(167,139,250,.4)');
    R.ellipse(-0.9,0,0.85,0.8,'rgba(167,139,250,.4)');
    // pylons
    R.pylon(0.9,0); R.pylon(-0.9,0);
    const s=this.st;
    this.pts.forEach((p,k)=>{
      if(k<s.i) return;
      R.ring(p[0],p[1],0.28, k===s.i?'#a78bfa':'rgba(140,163,184,.3)');
      R.text(p[0],p[1],String(k+1), k===s.i?'#a78bfa':'#5c7186');
    });
    R.pad(0,0,0.001);
  }
},
{
  id:9, stage:2, name:'五點精準降落', skill:'瞄準降落在指定色塊降落墊',
  goal:'依照指定顏色順序,輕降在 5 個色塊降落墊上(觸地即算,重落地記失誤),每次降落後重新起飛前往下一塊。',
  keys:'降落前先在墊子正上方<b>懸停對準</b>,再慢慢收油門。下降太快 = 重落地失誤。',
  coach:'<b>降落是可以練的射門。</b>五點降落練的是「看點、對點、收油門」三拍節奏。比賽計時賽就是這樣輪換電池的——降得準,換電快,上場時間就是你的。',
  par:65, wind:0.24,
  steps:['🟦 藍色墊','🟥 紅色墊','🟧 橙色墊','🟩 綠色墊','🟪 紫色墊'],
  st:{i:0,air:true},
  pads:[[-1.7,1.5,'#4fa8ff','藍'],[1.7,1.5,'#ff5c5c','紅'],[1.7,-1.5,'#ff8a3c','橙'],[-1.7,-1.5,'#39d98a','綠'],[0,0,'#a78bfa','紫']],
  setup(){ this.st={i:0,air:false}; drone.x=0; drone.y=-2.2; },
  update(dt){
    const s=this.st;
    if(drone.z>0.5) s.air=true;
    if(s.i<5 && touchdown.justLanded && s.air){
      const p=this.pads[s.i];
      if(Math.hypot(drone.x-p[0],drone.y-p[1])<=0.34){
        setStep(s.i,true); s.i++; s.air=false; ping();
      } else {
        addFault('降錯位置!重新起飛對準');
      }
    }
    if(s.i<5){
      const p=this.pads[s.i];
      liveGoal(`目標:<b style="color:${p[2]}">${p[3]}色降落墊</b>(${s.i} / 5)・${s.air?'對準後緩慢下降':'重新起飛'}`);
    }
    if(s.i>=5 && drone.z<0.05) return true;
  },
  draw(R){
    const s=this.st;
    this.pads.forEach((p,k)=>{
      const state=k<s.i?'done':k===s.i?'cur':'idle';
      R.padColor(p[0],p[1],p[2],state,p[3]);
    });
    R.pad(0,-2.2);
  }
},
{
  id:10, stage:2, name:'擋球守門小遊戲', skill:'守門走位擋球 ×5 + 落地 1 秒內斷電',
  goal:'對手連續射門!守在球門前的守備區,左右走位+上下升降,用機身把紅色來球擋下。來球有高有低,你的高度要跟「球高」對上(±35cm)才擋得到。成功擋下 5 球後降落,並在觸地後 1 秒內按下「斷電」。被射進球門會記失誤。',
  keys:'<b>右桿 ←/→</b> 左右走位補位、<b>左桿 W/S</b> 升降對高度(右側高度尺會顯示來球高度帶)。先對高度、再對落點!落地瞬間立刻按 <b>X 斷電</b>!',
  coach:'<b>守門員的三個本能。</b>① 眼睛先看「球高」再看落點——高度不對,位置再準也擋不到;② 擋下後不追球,立刻回中路準備下一球;③ 緊急斷電是安全的最後一道線——把「落地→斷電」練成反射動作,教練才敢放你上場。',
  par:52, wind:0.26,
  steps:['起飛,進入球門前守備區','擋下第 1 球','擋下第 2 球','擋下第 3 球','擋下第 4 球','擋下第 5 球','降落,1 秒內完成斷電 ⏻'],
  st:{phase:0,blocks:0,shot:0,ball:null,cd:1.5},
  view:'goal',   // 守門關預設用球門後視角,才看得到來球
  setup(){ this.st={phase:0,blocks:0,shot:0,ball:null,cd:1.5}; drone.y=1.6; drone.hdg=Math.PI; },
  update(dt){
    const s=this.st;
    const inBox=Math.abs(drone.x)<=1.1 && drone.y>=1.0 && drone.y<=2.3;
    if(s.phase===0){
      setStep(0, drone.z>0.5 && inBox);
      if(drone.z>0.3) corridorCheck(dt,!inBox,'回到守備區!');
      if(!s.ball){
        if(drone.z>0.5) s.cd-=dt;
        if(s.cd<=0 && drone.z>0.5){
          const sx=Math.random()*3.2-1.6, tx=Math.random()*1.2-0.6;
          const spd=1.1+Math.min(0.9,s.shot*0.15);   // 一球比一球快
          const dx=tx-sx, dy=2.45-(-2.4), L=Math.hypot(dx,dy);
          s.ball={x:sx,y:-2.4,z:0.6+Math.random()*1.2,vx:dx/L*spd,vy:dy/L*spd,live:true,tt:0};
          s.shot++; ping(500);
        }
      } else {
        const b=s.ball;
        b.x+=b.vx*dt; b.y+=b.vy*dt; b.tt+=dt;
        if(b.live){
          const dh=Math.hypot(drone.x-b.x,drone.y-b.y), dz=Math.abs(drone.z-b.z);
          if(drone.z>0.3 && drone.motors && dh<=0.38 && dz<=0.35){
            // 擋下!球被彈回南場
            b.live=false; b.tt=0;
            const sp=Math.hypot(b.vx,b.vy);
            b.vy=-sp*0.9; b.vx=(b.x-drone.x)*3;
            s.blocks++; setStep(s.blocks,true); ping(1200);
          } else if(b.y>=2.35){
            if(Math.abs(b.x)<=0.85) addFault('被進球了!守住球門!');
            s.ball=null; s.cd=1.4;
          }
        } else if(b.tt>2.5 || b.y<-2.7 || Math.abs(b.x)>2.7){
          s.ball=null; s.cd=1.2;
        }
      }
      if(s.blocks>=5){ s.phase=1; s.ball=null; ping(); }
      const b2=s.ball;
      if(b2&&b2.live){
        const zOk=Math.abs(drone.z-b2.z)<=0.35;
        liveGoal(`已擋 <b style="color:var(--hud)">${s.blocks} / 5</b>・來球球高 <b style="color:${zOk?'var(--hud)':'var(--warn)'}">${fmt1(b2.z)}m</b>|你的高度 ${fmt2(drone.z)}m`);
      } else {
        liveGoal(`已擋 <b style="color:var(--hud)">${s.blocks} / 5</b>・${drone.z>0.5?'守住中路,下一球即將發出…':'先起飛進入守備區'}`);
      }
    } else {
      if(drone.z<0.02 && !drone.motors){
        const dtc=cutAt-touchdown.t;
        if(dtc>=0 && dtc<=1){ setStep(6,true); return true; }
      }
      if(drone.z<0.02 && drone.motors && t-touchdown.t>1 && touchdown.t>0){
        addFault('斷電太慢(>1 秒)!重新起飛再降');
        touchdown.t=-9;
      }
      liveGoal(`🥅 成功擋下 5 球!<b style="color:var(--warn)">降落後 1 秒內按 X 斷電</b>`);
    }
  },
  draw(R){
    // goal + defense box
    R.goal(2.45);
    R.zoneRect(0,1.65,2.2,1.3,{stroke:'rgba(79,168,255,.5)',dash:true});
    R.text(0,0.85,'守備區','#4fa8ff');
    R.pad(0,1.6,0.001);
    const s=this.st, b=s.ball;
    if(b){
      if(b.live) R.line(b.x,b.y,b.x+b.vx*2.2,b.y+b.vy*2.2,'rgba(255,92,92,.35)',{dash:true,h:b.z});
      const zOk=Math.abs(drone.z-b.z)<=0.35;
      R.ball(b.x,b.y,b.z,b.live,zOk);
      if(b.live) R.text(b.x,b.y-0.35,`球高 ${fmt1(b.z)}m`, zOk?'#4fe3a3':'#ff8a3c');
    }
    R.text(0,0.45,`已擋 ${s.blocks} / 5`,'#8ca3b8');
    if(b&&b.live) R.altBand(Math.max(0.1,b.z-0.35),b.z+0.35,true);
    else R.altBand(0.5,2.0,true);
  }
}
];

/* =========================================================
   HELPERS shared by missions
   ========================================================= */
function liveGoal(html){ $('gGoal').innerHTML=html; }
function setStep(i,done){
  const li=$('gSteps').children[i]; if(!li) return;
  if(done){ li.classList.add('done'); li.classList.remove('cur'); }
}
function refreshCurrentStep(){
  const lis=[...$('gSteps').children];
  lis.forEach(li=>li.classList.remove('cur'));
  const first=lis.find(li=>!li.classList.contains('done'));
  if(first) first.classList.add('cur');
}
function flashWarn(msg){
  $('warnflash').textContent=msg; $('warnflash').classList.add('on');
  warnUntil=t+1.4;
}
function addFault(msg){
  faults++; $('roFault').textContent=faults;
  $('roFaultWrap').classList.add('warnc');
  flashWarn(msg);
}
function corridorCheck(dt,violating,msg){
  if(violating){ warnAcc+=dt; if(warnAcc>=1){ addFault(msg); warnAcc=0; } else if(warnAcc>0.15) flashWarn(msg); }
  else warnAcc=Math.max(0,warnAcc-dt*2);
}
function distToSquare(x,y,h){
  const dx=Math.max(Math.abs(x)-h,0), dy=Math.max(Math.abs(y)-h,0);
  const outside=Math.hypot(dx,dy);
  const inside=Math.min(h-Math.abs(x),h-Math.abs(y));
  return Math.abs(x)<=h&&Math.abs(y)<=h ? inside : outside; // distance to edge either way
}
/* ---------- FX 事件佇列(粒子特效,由 render3d 消化) ---------- */
const FX=[];
/* tiny audio ping */
let AC=null;
function ping(freq){
  // 成功事件(預設 880 或 ≥1000 的高音)在機身位置放粒子
  if(scene==='play' && (freq===undefined||freq>=1000)){
    FX.push({type:'burst',x:drone.x,y:drone.y,z:Math.max(drone.z,0.2),
      color:(freq&&freq>=1200)?0x4fe3a3:0xffd34d});
  }
  try{
    AC=AC||new (window.AudioContext||window.webkitAudioContext)();
    const o=AC.createOscillator(), gn=AC.createGain();
    o.frequency.value=freq||880; o.type='sine';
    gn.gain.setValueAtTime(0.12,AC.currentTime);
    gn.gain.exponentialRampToValueAtTime(0.0001,AC.currentTime+0.25);
    o.connect(gn).connect(AC.destination); o.start(); o.stop(AC.currentTime+0.26);
  }catch(e){}
}

/* =========================================================
   PHYSICS
   ========================================================= */
function physics(dt){
  const wind=M?M.wind:0.2;
  const wx=Math.sin(t*0.55+windPhase)*wind*0.6 + Math.sin(t*1.7)*wind*0.25;
  const wy=Math.cos(t*0.43+windPhase*2)*wind*0.6 + Math.cos(t*1.3)*wind*0.25;
  touchdown.justLanded=false;

  if(drone.motors){
    drone.hdg+=stick.yaw*2.6*dt;
    if(drone.z>0.02){
      const fX=Math.sin(drone.hdg), fY=Math.cos(drone.hdg);
      const rX=Math.cos(drone.hdg), rY=-Math.sin(drone.hdg);
      // M.acc:關卡加速度倍率。預設極速=3.4/1.7=2.0 m/s,
      // 衝刺關(M7)需 ≥2.0 過線,故給 1.5 倍 → 極速 3.0 m/s
      const A=3.4*(M&&M.acc?M.acc:1);
      drone.vx+=(rX*stick.roll*A + fX*stick.pitch*A + wx)*dt;
      drone.vy+=(rY*stick.roll*A + fY*stick.pitch*A + wy)*dt;
    }
    drone.vz+=stick.thr*3.2*dt;
    drone.vz-=drone.vz*2.6*dt;
  } else {
    drone.vz-=4.5*dt;
  }
  drone.vx-=drone.vx*1.7*dt;
  drone.vy-=drone.vy*1.7*dt;

  // grounded
  if(drone.z<=0.001 && drone.vz<=0){
    drone.vz=0;
    drone.vx-=drone.vx*8*dt; drone.vy-=drone.vy*8*dt;
    if(drone.motors && stick.thr>0.18) drone.vz=0.25; // lift-off
  }
  drone.x+=drone.vx*dt; drone.y+=drone.vy*dt;
  const prevZ=drone.z;
  drone.z+=drone.vz*dt;
  if(drone.z>2.6){ drone.z=2.6; drone.vz=Math.min(0,drone.vz); }
  if(drone.z<=0 && prevZ>0){
    // touchdown
    if(drone.vz<-1.5){ addFault('重落地!下降太快'); ping(220); }
    touchdown.t=t; touchdown.vz=drone.vz; touchdown.justLanded=true;
    drone.z=0; drone.vz=0;
  }
  // walls
  const h=world.half-0.12;
  if(Math.abs(drone.x)>h){ drone.x=clamp(drone.x,-h,h); drone.vx*=-0.35; }
  if(Math.abs(drone.y)>h){ drone.y=clamp(drone.y,-h,h); drone.vy*=-0.35; }
}

function doCut(){
  if(scene!=='play'||!drone.motors) return;
  drone.motors=false; cutAt=t; ping(300);
  if(M&&M.id!==10&&drone.z>0.3) flashWarn('空中斷電!自由落體中');
}

/* =========================================================
   SCENE FLOW
   ========================================================= */
function stars0(id){ const p=P(); return p&&p.stars?(p.stars[id]||0):0; }
function unlocked(i){
  if(save.teacher) return true;
  if(i===0) return true;
  return stars0(missions[i-1].id)>0;
}
function starStr(n,total){
  let s=''; for(let k=0;k<(total||3);k++) s+= k<n?'★':'<span class="off">★</span>';
  return s;
}
function renderMenu(){
  const g1=$('grid1'), g2=$('grid2'); g1.innerHTML=''; g2.innerHTML='';
  let tot=0;
  missions.forEach((m,i)=>{
    tot+=stars0(m.id);
    const b=document.createElement('button');
    b.className='mcard'+(unlocked(i)?'':' locked');
    b.innerHTML=`<span class="num">MISSION ${String(m.id).padStart(2,'0')}</span>
      <span class="nm">${m.name}</span>
      <span class="skill">${m.skill}</span>
      <span class="stars">${starStr(stars0(m.id))}</span>`;
    if(unlocked(i)) b.addEventListener('click',()=>openBrief(i));
    else b.disabled=true;
    (m.stage===1?g1:g2).appendChild(b);
  });
  $('totalStars').textContent=`★ ${tot} / 30`;
  const rank= tot>=27?'金牌競技選手': tot>=20?'正式球員': tot>=12?'儲備球員': tot>=5?'初階飛手':'見習飛手';
  $('rankTag').textContent=rank;
  $('btnPlayer').textContent = save.current?('👤 學員:'+save.current):'👤 學員:未登記(點我)';
  $('btnTeacher').textContent = save.teacher?'教師模式:已解鎖 ✓':'教師模式:全部解鎖';
}
function openBrief(i){
  mi=i; M=missions[i];
  $('bTag').textContent=`任務 ${String(M.id).padStart(2,'0')}・第${M.stage===1?'一':'二'}階段`;
  $('bTitle').textContent=M.name;
  $('bSkill').textContent=M.skill;
  $('bGoal').innerHTML=M.goal;
  $('bKeys').innerHTML='🕹️ '+M.keys;
  $('ovlDone').classList.remove('show');
  $('ovlBrief').classList.add('show');
  scene='brief';
  $('menu').style.display='none'; $('game').style.display='block';
  prepMission();
  Render3D.setView(M.view||'chase');   // 關卡預設視角(進關重設;重試 R 不重設)
  Render3D.resize();
  if(!save.current){ renderPlayers(); $('ovlPlayer').classList.add('show'); }
}
function prepMission(){
  drone.x=0; drone.y=0; drone.z=0; drone.vx=drone.vy=drone.vz=0; drone.hdg=0; drone.motors=true;
  t=0; started=false; faults=0; warnAcc=0; warnUntil=0; altBand=null;
  $('warnflash').classList.remove('on');
  touchdown={t:-9,vz:0,justLanded:false}; cutAt=-9;
  $('roFault').textContent='0'; $('roFaultWrap').classList.remove('warnc');
  $('gTitle').textContent=`任務 ${String(M.id).padStart(2,'0')}・${M.name}`;
  $('gSub').textContent=M.skill;
  $('gCoach').innerHTML=M.coach;
  const ul=$('gSteps'); ul.innerHTML='';
  M.steps.forEach(s=>{ const li=document.createElement('li'); li.textContent=s; ul.appendChild(li); });
  M.setup();
  liveGoal(M.goal);
  refreshCurrentStep();
}
function startMission(i){
  mi=i; M=missions[i];
  $('ovlBrief').classList.remove('show');
  $('ovlDone').classList.remove('show');
  prepMission(); scene='play';
}
function backToMenu(){
  scene='menu';
  $('ovlBrief').classList.remove('show'); $('ovlDone').classList.remove('show');
  $('game').style.display='none'; $('menu').style.display='block';
  renderMenu();
}
function completeMission(){
  scene='done';
  const time=t;
  let s = time<=M.par?3 : time<=M.par*1.6?2 : 1;
  s = Math.max(1, s - Math.floor(faults/3));
  const pl=ensurePlayer();
  if(s>(pl.stars[M.id]||0)) pl.stars[M.id]=s;
  const best=pl.results[M.id];
  if(!best || s>best.s || (s===best.s && time<best.t)){
    pl.results[M.id]={s, t:+time.toFixed(1), f:faults, d:new Date().toISOString().slice(0,10)};
  }
  persist();
  $('rCode').textContent=makeCode(save.current, M.id, s, time, faults);
  $('rTitle').textContent=`任務 ${String(M.id).padStart(2,'0')}・${M.name}`;
  $('rStars').innerHTML=starStr(s);
  $('rTime').textContent=`TIME ${time.toFixed(1)}s(3★ 標準 ≤ ${M.par}s)`;
  $('rFault').textContent=`FAULT ${faults}`;
  const v = s===3?'教科書等級的飛行!這一科你已經可以當小教練了。'
        : s===2?'穩穩過關。想拿三星:動作可以更果斷,桿量更小更早。'
        : '完成了!先求穩、再求快——多飛兩趟,星星自然會來。';
  $('rVerdict').textContent=v + (faults>0?`(本次失誤 ${faults} 次,失誤每 3 次扣 1 星)`:'');
  const hasNext = mi<missions.length-1;
  $('btnNext').style.display=hasNext?'':'none';
  $('ovlDone').classList.add('show');
  FX.push({type:'confetti'});
  ping(1175); setTimeout(()=>ping(1568),140);
}

/* =========================================================
   學員登記
   ========================================================= */
function cleanName(n){ return (n||'').replace(/[\s|,-]/g,'').slice(0,10); }
function renderPlayers(){
  const box=$('plList'); box.innerHTML='';
  Object.keys(save.players).forEach(nm=>{
    const p=save.players[nm];
    const tot=Object.values(p.stars||{}).reduce((a,b)=>a+b,0);
    const chip=document.createElement('button');
    chip.className='pchip'+(nm===save.current?' cur':'');
    chip.innerHTML=`${nm} <span class="st">★${tot}</span> <span class="del">✕</span>`;
    chip.querySelector('.del').addEventListener('click',ev=>{
      ev.stopPropagation();
      if(chip.classList.contains('confirmdel')){
        delete save.players[nm];
        if(save.current===nm) save.current='';
        persist(); renderPlayers(); renderMenu();
      } else {
        chip.classList.add('confirmdel');
        chip.querySelector('.del').textContent='再按一次刪除';
      }
    });
    chip.addEventListener('click',()=>{ save.current=nm; persist(); renderPlayers(); renderMenu(); });
    box.appendChild(chip);
  });
}

/* =========================================================
   成績代碼(名字-關卡-星-秒-失誤-校驗碼)
   ========================================================= */
function crc(s){ let h=7; for(const c of s) h=(h*31+c.codePointAt(0))%46656; return h.toString(36).toUpperCase().padStart(3,'0'); }
function makeCode(name,id,s,tm,f){
  name=cleanName(name)||'訪客';
  const body=[name,id,s,(+tm).toFixed(1),f];
  return body.join('-')+'-'+crc(body.join('|'));
}
function parseCode(str){
  const p=(str||'').trim().split('-');
  if(p.length!==6) return null;
  const [name,id,s,tm,f,ck]=p;
  if(crc([name,id,s,tm,f].join('|'))!==ck.toUpperCase()) return null;
  const idn=+id, sn=+s, tn=parseFloat(tm), fn=+f;
  if(!name||!(idn>=1&&idn<=10)||!(sn>=1&&sn<=3)||!(tn>0)||!(fn>=0)) return null;
  return {name:cleanName(name), id:idn, s:sn, t:tn, f:fn};
}
function mergeResult(name,id,r){
  if(!name) return;
  const p=save.players[name]=save.players[name]||{stars:{},results:{}};
  if(r.s>(p.stars[id]||0)) p.stars[id]=r.s;
  const b=p.results[id];
  if(!b || r.s>b.s || (r.s===b.s && r.t<b.t)) p.results[id]={s:r.s,t:r.t,f:r.f,d:r.d||new Date().toISOString().slice(0,10)};
}

/* =========================================================
   計分排行榜
   ========================================================= */
let boardTab='total';
function openBoard(){
  const sel=$('bdMission');
  if(!sel.options.length) missions.forEach(m=>{
    const o=document.createElement('option'); o.value=m.id;
    o.textContent=`任務 ${String(m.id).padStart(2,'0')} ${m.name}`;
    sel.appendChild(o);
  });
  renderBoard(); $('ovlBoard').classList.add('show');
}
function renderBoard(){
  $('tabTotal').classList.toggle('on',boardTab==='total');
  $('tabMission').classList.toggle('on',boardTab==='mission');
  $('bdMission').style.display=boardTab==='mission'?'':'none';
  const tb=$('bdTable');
  if(boardTab==='total'){
    const rows=Object.entries(save.players).map(([nm,p])=>{
      const rs=Object.values(p.results||{});
      return {nm,
        stars:Object.values(p.stars||{}).reduce((a,b)=>a+b,0),
        done:rs.length,
        time:rs.reduce((a,r)=>a+r.t,0)};
    }).filter(r=>r.done>0||r.stars>0);
    rows.sort((a,b)=>b.stars-a.stars || a.time-b.time || a.nm.localeCompare(b.nm,'zh-Hant'));
    tb.innerHTML='<tr><th>排名</th><th>學員</th><th>總星等</th><th>完成關數</th><th>總時間</th></tr>'+
      (rows.length?rows.map((r,i)=>`<tr${i===0?' class="top1"':''}><td>${i+1}</td><td class="nm">${r.nm}</td><td class="st">★${r.stars}</td><td>${r.done} / 10</td><td>${r.time.toFixed(1)}s</td></tr>`).join('')
      :'<tr><td colspan="5" style="color:var(--faint)">還沒有成績——完成任務或登錄成績代碼後就會出現。</td></tr>');
  } else {
    const id=+$('bdMission').value||1;
    const rows=[];
    Object.entries(save.players).forEach(([nm,p])=>{ const r=(p.results||{})[id]; if(r) rows.push(Object.assign({nm},r)); });
    rows.sort((a,b)=>b.s-a.s || a.t-b.t || a.nm.localeCompare(b.nm,'zh-Hant'));
    tb.innerHTML='<tr><th>排名</th><th>學員</th><th>星等</th><th>時間</th><th>失誤</th><th>日期</th></tr>'+
      (rows.length?rows.map((r,i)=>`<tr${i===0?' class="top1"':''}><td>${i+1}</td><td class="nm">${r.nm}</td><td class="st">${'★'.repeat(r.s)}</td><td>${r.t.toFixed(1)}s</td><td>${r.f}</td><td>${r.d||'—'}</td></tr>`).join('')
      :'<tr><td colspan="6" style="color:var(--faint)">這一關還沒有成績。</td></tr>');
  }
}

function download(fn,text,type){
  const b=new Blob([text],{type}); const u=URL.createObjectURL(b);
  const a=document.createElement('a'); a.href=u; a.download=fn;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(u),5000);
}

/* =========================================================
   共用 UI 事件（兩版頁面的 DOM id 相同）
   ========================================================= */
function bindCommonUI(){
  $('btnCut').addEventListener('click',doCut);
  $('btnRetry').addEventListener('click',()=>startMission(mi));
  $('btnStart').addEventListener('click',()=>startMission(mi));
  $('btnBriefBack').addEventListener('click',()=>backToMenu());
  $('btnBack').addEventListener('click',()=>backToMenu());
  $('btnDoneBack').addEventListener('click',()=>backToMenu());
  $('btnNext').addEventListener('click',()=>{ if(mi<missions.length-1) openBrief(mi+1); });
  $('btnAgain').addEventListener('click',()=>startMission(mi));
  $('btnStd').addEventListener('click',()=>$('ovlStd').classList.add('show'));
  $('btnStdClose').addEventListener('click',()=>$('ovlStd').classList.remove('show'));
  $('btnTeacher').addEventListener('click',()=>{ save.teacher=!save.teacher; persist(); renderMenu(); });
  $('btnReset').addEventListener('click',()=>{ save={players:{},current:'',teacher:save.teacher}; persist(); renderMenu(); });
  $('btnPlayer').addEventListener('click',()=>{ renderPlayers(); $('plName').value=''; $('ovlPlayer').classList.add('show'); });
  $('btnPlClose').addEventListener('click',()=>$('ovlPlayer').classList.remove('show'));
  $('btnPlOk').addEventListener('click',()=>{
    const nm=cleanName($('plName').value);
    if(nm){
      save.players[nm]=save.players[nm]||{stars:{},results:{}};
      save.current=nm; persist();
    }
    $('ovlPlayer').classList.remove('show');
    renderMenu();
  });
  $('btnCopyCode').addEventListener('click',()=>{
    const txt=$('rCode').textContent;
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(()=>{});
    $('btnCopyCode').textContent='已複製 ✓';
    setTimeout(()=>{$('btnCopyCode').textContent='複製';},1500);
  });
  $('btnBoard').addEventListener('click',openBoard);
  $('btnBoardClose').addEventListener('click',()=>$('ovlBoard').classList.remove('show'));
  $('tabTotal').addEventListener('click',()=>{boardTab='total';renderBoard();});
  $('tabMission').addEventListener('click',()=>{boardTab='mission';renderBoard();});
  $('bdMission').addEventListener('change',renderBoard);
  $('btnAddCode').addEventListener('click',()=>{
    const lines=$('codeIn').value.split(/\n+/).map(s=>s.trim()).filter(Boolean);
    let ok=0,bad=0;
    lines.forEach(l=>{ const r=parseCode(l); if(r){ mergeResult(r.name,r.id,r); ok++; } else bad++; });
    if(ok) persist();
    const m=$('codeMsg');
    m.textContent=lines.length?`已登錄 ${ok} 筆${bad?`,${bad} 筆代碼有誤(請檢查是否抄錯)`:''}`:'請先貼上成績代碼';
    m.classList.toggle('bad',bad>0||!lines.length);
    if(ok){ $('codeIn').value=''; renderBoard(); renderMenu(); }
  });
  $('btnCsv').addEventListener('click',()=>{
    let csv='﻿學員,任務,任務名稱,星等,時間(秒),失誤,日期\n';
    Object.entries(save.players).forEach(([nm,p])=>{
      Object.entries(p.results||{}).forEach(([id,r])=>{
        const m=missions.find(x=>x.id===+id);
        csv+=`${nm},${id},${m?m.name:''},${r.s},${r.t},${r.f},${r.d||''}\n`;
      });
    });
    download('無人機足球成績.csv',csv,'text/csv');
  });
  $('btnJson').addEventListener('click',()=>{
    download('無人機足球成績備份.json',JSON.stringify({players:save.players},null,1),'application/json');
  });
  $('btnImp').addEventListener('click',()=>$('impFile').click());
  $('impFile').addEventListener('change',ev=>{
    const f=ev.target.files[0]; if(!f) return;
    const rd=new FileReader();
    rd.onload=()=>{
      try{
        const data=JSON.parse(rd.result);
        const players=data.players||data;
        let n=0;
        Object.entries(players).forEach(([nm,p])=>{
          Object.entries(p.results||{}).forEach(([id,r])=>{ mergeResult(cleanName(nm),+id,r); n++; });
        });
        persist(); renderBoard(); renderMenu();
        $('codeMsg').textContent=`備份匯入完成,合併 ${n} 筆成績`; $('codeMsg').classList.remove('bad');
      }catch(e){ $('codeMsg').textContent='匯入失敗:不是有效的備份檔'; $('codeMsg').classList.add('bad'); }
    };
    rd.readAsText(f); ev.target.value='';
  });
  $('btnClearBoard').addEventListener('click',()=>{
    const b=$('btnClearBoard');
    if(b.dataset.arm){
      save.players={}; save.current=''; persist(); renderBoard(); renderMenu();
      b.textContent='清空成績'; delete b.dataset.arm;
    } else {
      b.dataset.arm='1'; b.textContent='再按一次確認清空!';
      setTimeout(()=>{ b.textContent='清空成績'; delete b.dataset.arm; },3000);
    }
  });
}

/* =========================================================
   MAIN LOOP — 頁面呼叫 startApp() 啟動
   window.readInput() 由各頁面提供（鍵盤/虛擬搖桿/手把）
   ========================================================= */
let last=performance.now();
function frame(now){
  const dt=Math.min(0.033,Math.max(0,(now-last)/1000)); last=now;
  if(window.pollFrame) window.pollFrame();   // 手把版:每幀輪詢(含選單導航)
  if(scene==='play'){
    if(window.readInput) window.readInput();
    if(started) t+=dt;
    physics(dt);
    const done=M.update(dt);
    refreshCurrentStep();
    if(t>warnUntil) $('warnflash').classList.remove('on');
    if(done) completeMission();
  }
  if(scene==='play'||scene==='brief'||scene==='done'){
    altBand=null;
    R.begin();
    if(M) M.draw(R);
    Render3D.render(dt);
    // HUD readouts
    $('roTime').textContent=t.toFixed(1);
    $('dAlt').textContent=fmt2(drone.z)+'m';
    $('dAlt').classList.toggle('warnc', altBand&&(drone.z<altBand.a||drone.z>altBand.b)&&drone.z>0.05);
    const deg=((drone.hdg*180/Math.PI)%360+360)%360;
    const dirName= deg<45||deg>=315?'前': deg<135?'右': deg<225?'後':'左';
    $('dHdg').textContent=`${dirName} ${String(Math.round(deg)).padStart(3,'0')}°`;
    $('dSpd').textContent=fmt1(Math.hypot(drone.vx,drone.vy))+'m/s';
  }
  requestAnimationFrame(frame);
}
function startApp(){
  bindCommonUI();
  Render3D.init();
  renderMenu();
  requestAnimationFrame(frame);
}
