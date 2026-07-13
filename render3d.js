'use strict';
/* =========================================================
   render3d.js — Three.js 3D 渲染層
   消化 game-core.js 的 R.list 顯示指令,提供三種視角:
   fpv(第一人稱)/ chase(追機)/ top(俯視)
   座標轉換:世界 (x東,y北,z上) → three (x, z, -y)
   ========================================================= */
const Render3D=(()=>{

let renderer,scene3,camera,container,glCv,hudCv,hudCtx;
let viewMode='chase';                     // chase | fpv | top | goal
const VIEW_NAMES={chase:'追機視角',fpv:'第一人稱',top:'俯視視角',goal:'守門視角'};
const VIEW_ORDER=['chase','fpv','top','goal'];
let hudW=800,hudH=500;
let droneGrp,propMeshes=[],cageMat,shadowMesh,pwrSprite;
const camPos=new THREE.Vector3(), camTgt=new THREE.Vector3();
let camSnap=true;
const pools={};
let lastBall=null;                        // 本幀來球(HUD 邊緣箭頭用)
let sceneryGrp=null, sceneryOn=true;      // 體育館場景+高畫質開關
let floorMesh,gridMat,turfTex,darkTex,boundMat;
let composer=null,bloomPass=null;         // 後製(Bloom 泛光,r147 examples/js)
let dirLight=null,shadowCatcher=null;     // 陰影

/* ---------- color util:'#rgb(a)' / 'rgba()' → hex+alpha ---------- */
function parseColor(str){
  if(!str) return {c:0xffffff,a:1};
  str=str.trim();
  if(str[0]==='#'){
    let h=str.slice(1);
    if(h.length===3) h=h.split('').map(c=>c+c).join('');
    if(h.length===8) return {c:parseInt(h.slice(0,6),16), a:parseInt(h.slice(6),16)/255};
    return {c:parseInt(h,16), a:1};
  }
  const m=str.match(/rgba?\(([^)]+)\)/);
  if(m){
    const p=m[1].split(',').map(parseFloat);
    return {c:(p[0]<<16)|(p[1]<<8)|p[2], a:p.length>3?p[3]:1};
  }
  return {c:0xffffff,a:1};
}
const V=(x,y,z)=>new THREE.Vector3(x,z,-y);   // world→three

/* ---------- object pool ---------- */
function makePool(name,createFn){
  const arr=[]; let n=0;
  const p={
    get(){
      let o=arr[n];
      if(!o){ o=createFn(); scene3.add(o.root); arr.push(o); }
      n++; o.root.visible=true; return o;
    },
    sweep(){ for(let i=n;i<arr.length;i++) arr[i].root.visible=false; n=0; }
  };
  pools[name]=p; return p;
}
function sweepAll(){ Object.values(pools).forEach(p=>p.sweep()); }

/* ---------- text sprite ---------- */
function createTextSprite(w,h,scale){
  const cv=document.createElement('canvas'); cv.width=w||256; cv.height=h||64;
  const ctx=cv.getContext('2d');
  const tex=new THREE.CanvasTexture(cv); tex.minFilter=THREE.LinearFilter;
  const sp=new THREE.Sprite(new THREE.SpriteMaterial({map:tex,transparent:true,depthWrite:false}));
  sp.scale.set(scale||1.3,(scale||1.3)*cv.height/cv.width,1);
  sp.renderOrder=15;
  sp.userData={cv,ctx,tex,key:''};
  return sp;
}
function setSpriteText(sp,txt,color,font){
  const u=sp.userData, key=txt+'|'+color;
  if(u.key===key) return;
  u.key=key;
  const c=u.ctx, W=u.cv.width, H=u.cv.height;
  c.clearRect(0,0,W,H);
  c.font=font||`700 ${Math.round(H*0.48)}px "Microsoft JhengHei","PingFang TC",sans-serif`;
  c.textAlign='center'; c.textBaseline='middle';
  c.lineWidth=4; c.strokeStyle='rgba(5,8,13,.8)';
  c.strokeText(txt,W/2,H/2);
  c.fillStyle=color; c.fillText(txt,W/2,H/2);
  u.tex.needsUpdate=true;
}

/* =========================================================
   ARENA(靜態場景)
   ========================================================= */
function makeDarkFloorTex(){
  const cv=document.createElement('canvas'); cv.width=cv.height=512;
  const c=cv.getContext('2d');
  const grd=c.createRadialGradient(256,256,50,256,256,380);
  grd.addColorStop(0,'#101a28'); grd.addColorStop(1,'#0b111b');
  c.fillStyle=grd; c.fillRect(0,0,512,512);
  return new THREE.CanvasTexture(cv);
}
function makeTurfTex(){
  // 夜間球場草皮:南北向割草條紋 + 暗角
  const cv=document.createElement('canvas'); cv.width=cv.height=512;
  const c=cv.getContext('2d');
  for(let i=0;i<8;i++){
    c.fillStyle=i%2?'#123a24':'#0e2f1d';
    c.fillRect(i*64,0,64,512);
  }
  // 草的雜訊
  for(let k=0;k<2600;k++){
    c.fillStyle=`rgba(${20+Math.random()*30|0},${60+Math.random()*40|0},${30+Math.random()*25|0},.16)`;
    c.fillRect(Math.random()*512,Math.random()*512,2,2);
  }
  const vg=c.createRadialGradient(256,256,180,256,256,400);
  vg.addColorStop(0,'rgba(0,0,0,0)'); vg.addColorStop(1,'rgba(0,0,0,.5)');
  c.fillStyle=vg; c.fillRect(0,0,512,512);
  return new THREE.CanvasTexture(cv);
}
function buildArena(){
  const H=world.half, CEIL=2.6;
  // floor(貼圖依場景開關切換:草皮/深色)
  darkTex=makeDarkFloorTex(); turfTex=makeTurfTex();
  floorMesh=new THREE.Mesh(new THREE.PlaneGeometry(H*2+1.2,H*2+1.2),
    new THREE.MeshBasicMaterial({map:darkTex}));
  floorMesh.rotation.x=-Math.PI/2; floorMesh.position.y=-0.002; floorMesh.renderOrder=0;
  scene3.add(floorMesh);
  // 0.5m grid
  const gpts=[];
  for(let v=-2.5;v<=2.51;v+=0.5){
    gpts.push(V(v,-H,0),V(v,H,0));
    gpts.push(V(-H,v,0),V(H,v,0));
  }
  gridMat=new THREE.LineBasicMaterial({color:0x223148,transparent:true,opacity:.55});
  const grid=new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(gpts),gridMat);
  grid.position.y=0.004; grid.renderOrder=1;
  scene3.add(grid);
  // boundary rect + centerline + center circle(球場標線)
  boundMat=new THREE.LineBasicMaterial({color:0xe9f1f7,transparent:true,opacity:.4});
  const bl=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    [V(-H,-H,0),V(H,-H,0),V(H,H,0),V(-H,H,0)]),boundMat);
  bl.position.y=0.006; scene3.add(bl);
  const lineMat=new THREE.LineBasicMaterial({color:0xe9f1f7,transparent:true,opacity:.2});
  const cl=new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(-H,0,0),V(H,0,0)]),lineMat);
  cl.position.y=0.006; scene3.add(cl);
  const ccPts=[];
  for(let i=0;i<=64;i++){ const a=i/64*TAU; ccPts.push(V(Math.cos(a)*0.9,Math.sin(a)*0.9,0)); }
  const cc=new THREE.Line(new THREE.BufferGeometry().setFromPoints(ccPts),lineMat);
  cc.position.y=0.006; scene3.add(cc);
  // walls(半透明圍網,FPV 方向感)
  const wallMat=new THREE.MeshBasicMaterial({color:0x4fa8ff,transparent:true,opacity:.05,
    side:THREE.DoubleSide,depthWrite:false});
  [[0,H,0],[0,-H,Math.PI],[H,0,-Math.PI/2],[-H,0,Math.PI/2]].forEach(w=>{
    const p=new THREE.Mesh(new THREE.PlaneGeometry(H*2,CEIL),wallMat);
    p.position.set(w[0],CEIL/2,-w[1]); p.rotation.y=w[2]; p.renderOrder=30;
    scene3.add(p);
  });
  const top=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
    [V(-H,-H,CEIL),V(H,-H,CEIL),V(H,H,CEIL),V(-H,H,CEIL)]),
    new THREE.LineBasicMaterial({color:0x4fa8ff,transparent:true,opacity:.3}));
  scene3.add(top);
  [[-H,-H],[H,-H],[H,H],[-H,H]].forEach(c=>{
    const l=new THREE.Line(new THREE.BufferGeometry().setFromPoints([V(c[0],c[1],0),V(c[0],c[1],CEIL)]),
      new THREE.LineBasicMaterial({color:0x4fa8ff,transparent:true,opacity:.3}));
    scene3.add(l);
  });
  // 方位標示(牆面)
  [['前',0,H],['後',0,-H],['右',H,0],['左',-H,0]].forEach(d=>{
    const sp=createTextSprite(128,128,0.6);
    setSpriteText(sp,d[0],'rgba(140,163,184,.85)');
    sp.position.copy(V(d[1],d[2],1.6));
    scene3.add(sp);
  });
  // lights
  scene3.add(new THREE.HemisphereLight(0x8fa8c8,0x1a2536,1.05));
  dirLight=new THREE.DirectionalLight(0xfff2e0,.62); dirLight.position.set(3,6,2);
  dirLight.castShadow=true;
  dirLight.shadow.mapSize.set(1024,1024);
  dirLight.shadow.camera.left=-4.2; dirLight.shadow.camera.right=4.2;
  dirLight.shadow.camera.top=4.2; dirLight.shadow.camera.bottom=-4.2;
  dirLight.shadow.camera.near=1; dirLight.shadow.camera.far=16;
  dirLight.shadow.bias=-0.002;
  scene3.add(dirLight);
  // 陰影接收面(ShadowMaterial:只顯示陰影,不影響地板配色)
  shadowCatcher=new THREE.Mesh(new THREE.PlaneGeometry(H*2+1.2,H*2+1.2),
    new THREE.ShadowMaterial({opacity:.3}));
  shadowCatcher.rotation.x=-Math.PI/2; shadowCatcher.position.y=0.007;
  shadowCatcher.receiveShadow=true; shadowCatcher.renderOrder=1;
  scene3.add(shadowCatcher);
}

/* =========================================================
   STADIUM SCENERY(體育館場景,可用畫面按鈕開關)
   ========================================================= */
function makeStandTex(){
  // 觀眾席:一排排座位 + 隨機觀眾色點
  const cv=document.createElement('canvas'); cv.width=512; cv.height=160;
  const c=cv.getContext('2d');
  c.fillStyle='#0d1420'; c.fillRect(0,0,512,160);
  const palette=['#4fa8ff','#ff8a3c','#4fe3a3','#a78bfa','#ffd34d','#ff5c5c','#e9f1f7'];
  for(let row=0;row<6;row++){
    const y=14+row*24;
    c.fillStyle='#131d2c'; c.fillRect(0,y,512,16);
    for(let sx=4;sx<512;sx+=12){
      if(Math.random()<0.55){
        c.fillStyle=palette[Math.random()*palette.length|0];
        c.globalAlpha=.5+Math.random()*.4;
        c.beginPath(); c.arc(sx+4,y+7,3.4,0,TAU); c.fill();
        c.globalAlpha=1;
      }
    }
  }
  return new THREE.CanvasTexture(cv);
}
function makeBannerTex(){
  const cv=document.createElement('canvas'); cv.width=1024; cv.height=64;
  const c=cv.getContext('2d');
  c.fillStyle='#0e1826'; c.fillRect(0,0,1024,64);
  c.strokeStyle='#22314a'; c.lineWidth=3; c.strokeRect(2,2,1020,60);
  c.font='700 30px "Arial Black",Consolas,sans-serif';
  c.textBaseline='middle';
  c.fillStyle='#4fa8ff'; c.fillText('DRONE SOCCER',36,34);
  c.fillStyle='#4fe3a3'; c.fillText('訓練場',330,34);
  c.fillStyle='#8ca3b8'; c.fillText('DRONE SOCCER',480,34);
  c.fillStyle='#ff8a3c'; c.fillText('十大術科',790,34);
  const tex=new THREE.CanvasTexture(cv);
  tex.wrapS=THREE.RepeatWrapping;
  return tex;
}
function makeGlowTex(){
  const cv=document.createElement('canvas'); cv.width=cv.height=128;
  const c=cv.getContext('2d');
  const g=c.createRadialGradient(64,64,4,64,64,62);
  g.addColorStop(0,'rgba(255,246,214,1)');
  g.addColorStop(.3,'rgba(255,238,170,.55)');
  g.addColorStop(1,'rgba(255,238,170,0)');
  c.fillStyle=g; c.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(cv);
}
function buildScenery(){
  sceneryGrp=new THREE.Group();
  const H=world.half;
  // 夜空頂棚(漸層圓頂)
  const scv=document.createElement('canvas'); scv.width=32; scv.height=256;
  const sc=scv.getContext('2d');
  const sg=sc.createLinearGradient(0,0,0,256);
  sg.addColorStop(0,'#05080f'); sg.addColorStop(.55,'#0a1220'); sg.addColorStop(1,'#16283e');
  sc.fillStyle=sg; sc.fillRect(0,0,32,256);
  for(let k=0;k<90;k++){ // 星光
    sc.fillStyle=`rgba(233,241,247,${.2+Math.random()*.6})`;
    sc.fillRect(Math.random()*32,Math.random()*150,1,1);
  }
  const dome=new THREE.Mesh(new THREE.SphereGeometry(24,24,12),
    new THREE.MeshBasicMaterial({map:new THREE.CanvasTexture(scv),side:THREE.BackSide,fog:false}));
  sceneryGrp.add(dome);
  // 觀眾席(四面)
  const standTex=makeStandTex();
  [[0,1,0],[0,-1,Math.PI],[1,0,-Math.PI/2],[-1,0,Math.PI/2]].forEach(s=>{
    const st=new THREE.Mesh(new THREE.PlaneGeometry(10.5,3.4),
      new THREE.MeshBasicMaterial({map:standTex,transparent:true,opacity:.9}));
    st.position.set(s[0]*5.6,1.85,-s[1]*5.6);
    st.rotation.y=s[2]; st.rotation.x=-0.42;
    sceneryGrp.add(st);
  });
  // 廣告圍板(緊貼場地邊界外)
  const bannerTex=makeBannerTex();
  [[0,1,0],[0,-1,Math.PI],[1,0,-Math.PI/2],[-1,0,Math.PI/2]].forEach(s=>{
    const bd=new THREE.Mesh(new THREE.PlaneGeometry(H*2+0.6,0.42),
      new THREE.MeshBasicMaterial({map:bannerTex}));
    bd.position.set(s[0]*(H+0.18),0.21,-s[1]*(H+0.18));
    bd.rotation.y=s[2];
    sceneryGrp.add(bd);
  });
  // 四角聚光燈塔
  const glowTex=makeGlowTex();
  const poleMat=new THREE.MeshLambertMaterial({color:0x1b2636});
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(p=>{
    const tower=new THREE.Group();
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.1,4.8,8),poleMat);
    pole.position.y=2.4; pole.castShadow=true; tower.add(pole);
    const head=new THREE.Mesh(new THREE.BoxGeometry(0.6,0.28,0.12),
      new THREE.MeshBasicMaterial({color:0xfff6d6}));
    head.position.y=4.8; head.lookAt(0,0,0); tower.add(head);
    const glow=new THREE.Sprite(new THREE.SpriteMaterial({map:glowTex,transparent:true,
      blending:THREE.AdditiveBlending,depthWrite:false,opacity:.9}));
    glow.scale.set(1.6,1.6,1); glow.position.y=4.8; tower.add(glow);
    // 光束
    const beam=new THREE.Mesh(new THREE.ConeGeometry(1.9,5.6,20,1,true),
      new THREE.MeshBasicMaterial({color:0xfff2c4,transparent:true,opacity:.045,
        blending:THREE.AdditiveBlending,depthWrite:false,side:THREE.DoubleSide}));
    beam.position.y=4.8;
    const dir=new THREE.Vector3(-p[0]*3.4,-4.8,p[1]*3.4).normalize();
    beam.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),dir.clone().negate());
    beam.position.add(dir.clone().multiplyScalar(2.8));
    tower.add(beam);
    tower.position.set(p[0]*3.8,0,p[1]*3.8);
    sceneryGrp.add(tower);
  });
  scene3.add(sceneryGrp);
}
function applyScenery(){
  if(sceneryGrp) sceneryGrp.visible=sceneryOn;
  if(floorMesh){ floorMesh.material.map=sceneryOn?turfTex:darkTex; floorMesh.material.needsUpdate=true; }
  if(gridMat){ gridMat.color.setHex(sceneryOn?0x1e4d34:0x223148); gridMat.opacity=sceneryOn?.4:.55; }
  if(boundMat) boundMat.opacity=sceneryOn?.6:.4;
  if(scene3&&scene3.fog){ scene3.fog.near=sceneryOn?12:7; scene3.fog.far=sceneryOn?34:15; }
  renderer.setClearColor(sceneryOn?0x05080f:0x0a0f16);
  // 高畫質 = ACES 色調映射 + 即時陰影 + Bloom(render 時判斷)
  renderer.toneMapping=sceneryOn?THREE.ACESFilmicToneMapping:THREE.NoToneMapping;
  renderer.toneMappingExposure=1.18;
  renderer.shadowMap.enabled=sceneryOn;
  if(shadowCatcher) shadowCatcher.visible=sceneryOn;
  // toneMapping / shadowMap 改變需要重編譯 shader
  scene3.traverse(o=>{
    if(o.material){ (Array.isArray(o.material)?o.material:[o.material]).forEach(m=>{ m.needsUpdate=true; }); }
  });
  const b=$('btnScenery');
  if(b) b.textContent=sceneryOn?'🏟️ 場景:開':'🏟️ 場景:關';
}
function toggleScenery(){
  sceneryOn=!sceneryOn;
  try{ localStorage.setItem('ds3Scenery',sceneryOn?'1':'0'); }catch(e){}
  applyScenery();
}

/* =========================================================
   PARTICLES(FX 佇列:過點爆星 / 過關彩帶)
   ========================================================= */
const PMAX=600;
let pGeo,pPts,pData=[];
function buildParticles(){
  pGeo=new THREE.BufferGeometry();
  pGeo.setAttribute('position',new THREE.BufferAttribute(new Float32Array(PMAX*3),3));
  pGeo.setAttribute('color',new THREE.BufferAttribute(new Float32Array(PMAX*3),3));
  const mat=new THREE.PointsMaterial({size:0.055,vertexColors:true,transparent:true,
    blending:THREE.AdditiveBlending,depthWrite:false});
  pPts=new THREE.Points(pGeo,mat);
  pPts.frustumCulled=false; pPts.renderOrder=28;
  scene3.add(pPts);
}
function spawnBurst(x,y,z,hex){
  const col=new THREE.Color(hex);
  for(let k=0;k<26;k++){
    if(pData.length>=PMAX) break;
    const a=Math.random()*TAU, e=Math.random()*Math.PI-Math.PI/2, sp=0.9+Math.random()*1.6;
    pData.push({
      p:V(x,y,z),
      v:new THREE.Vector3(Math.cos(a)*Math.cos(e)*sp,Math.sin(e)*sp+0.8,Math.sin(a)*Math.cos(e)*sp),
      life:.7+Math.random()*.4, age:0, c:col, g:2.6
    });
  }
}
function spawnConfetti(){
  const cols=[0x4fe3a3,0x4fa8ff,0xff8a3c,0xa78bfa,0xffd34d,0xff5c5c];
  for(let k=0;k<130;k++){
    if(pData.length>=PMAX) break;
    pData.push({
      p:new THREE.Vector3(Math.random()*4-2,2.5+Math.random()*1.2,Math.random()*4-2),
      v:new THREE.Vector3(Math.random()*.6-.3,-(.5+Math.random()*.6),Math.random()*.6-.3),
      life:2.2+Math.random()*1.2, age:0, c:new THREE.Color(cols[k%cols.length]), g:.15
    });
  }
}
function updateParticles(dt){
  while(FX.length){
    const e=FX.shift();
    if(e.type==='confetti') spawnConfetti();
    else spawnBurst(e.x,e.y,e.z,e.color);
  }
  const pos=pGeo.attributes.position.array, col=pGeo.attributes.color.array;
  let n=0;
  for(let i=0;i<pData.length;i++){
    const d=pData[i];
    d.age+=dt;
    if(d.age>=d.life) continue;
    d.v.y-=d.g*dt;
    d.p.addScaledVector(d.v,dt);
    if(d.p.y<0.02){ d.p.y=0.02; d.v.y=0; d.v.x*=0.8; d.v.z*=0.8; }
    pData[n]=d;
    const f=1-d.age/d.life;
    pos[n*3]=d.p.x; pos[n*3+1]=d.p.y; pos[n*3+2]=d.p.z;
    col[n*3]=d.c.r*f; col[n*3+1]=d.c.g*f; col[n*3+2]=d.c.b*f;
    n++;
  }
  pData.length=n;
  pGeo.setDrawRange(0,n);
  pGeo.attributes.position.needsUpdate=true;
  pGeo.attributes.color.needsUpdate=true;
}

/* =========================================================
   DRONE(足球無人機:防撞球殼 + 四軸 + 橘色機頭)
   ========================================================= */
function buildDrone(){
  droneGrp=new THREE.Group();
  const CAGE=0.19;
  cageMat=new THREE.MeshBasicMaterial({color:0x4fa8ff,wireframe:true,transparent:true,opacity:.5});
  droneGrp.add(new THREE.Mesh(new THREE.SphereGeometry(CAGE,14,10),cageMat));
  const body=new THREE.Mesh(new THREE.SphereGeometry(0.07,12,10),
    new THREE.MeshLambertMaterial({color:0x2a3b52}));
  body.scale.y=0.6; body.castShadow=true; droneGrp.add(body);
  const nose=new THREE.Mesh(new THREE.ConeGeometry(0.05,0.11,10),
    new THREE.MeshBasicMaterial({color:0xff8a3c}));
  nose.rotation.x=-Math.PI/2; nose.position.set(0,0,-0.13);
  nose.castShadow=true;
  droneGrp.add(nose);
  const armMat=new THREE.MeshLambertMaterial({color:0x223148});
  const propMat=new THREE.MeshBasicMaterial({color:0xe9f1f7,transparent:true,opacity:.7});
  [[-1,-1],[1,-1],[-1,1],[1,1]].forEach((p,i)=>{
    const ax=p[0]*0.085, az=p[1]*0.085;
    const arm=new THREE.Mesh(new THREE.BoxGeometry(0.11,0.012,0.02),armMat);
    arm.position.set(ax/2,0.01,az/2); arm.rotation.y=Math.atan2(-az,ax);
    droneGrp.add(arm);
    const prop=new THREE.Mesh(new THREE.BoxGeometry(0.13,0.003,0.014),propMat);
    prop.position.set(ax,0.03,az); prop.userData.dir=i%2?1:-1;
    droneGrp.add(prop); propMeshes.push(prop);
  });
  scene3.add(droneGrp);
  // shadow
  shadowMesh=new THREE.Mesh(new THREE.CircleGeometry(0.17,24),
    new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.4,depthWrite:false}));
  shadowMesh.rotation.x=-Math.PI/2; shadowMesh.position.y=0.012; shadowMesh.renderOrder=2;
  scene3.add(shadowMesh);
  // PWR OFF
  pwrSprite=createTextSprite(256,64,0.8);
  setSpriteText(pwrSprite,'PWR OFF','#ff5c5c','700 34px Consolas,monospace');
  pwrSprite.visible=false;
  scene3.add(pwrSprite);
}
function updateDrone(dt){
  droneGrp.position.copy(V(drone.x,drone.y,Math.max(drone.z,0.028)+0.16));
  droneGrp.rotation.y=-drone.hdg;
  // 姿態傾斜(視覺回饋)
  droneGrp.rotation.x=stick.pitch*0.28*(drone.motors?1:0);
  droneGrp.rotation.z=-stick.roll*0.28*(drone.motors?1:0);
  drone.rot+=(drone.motors?40:0.6)*dt;
  propMeshes.forEach(p=>{ p.rotation.y=drone.rot*p.userData.dir; });
  cageMat.color.setHex(drone.motors?0x4fa8ff:0x8ca3b8);
  cageMat.opacity=drone.motors?.5:.3;
  shadowMesh.position.x=droneGrp.position.x;
  shadowMesh.position.z=droneGrp.position.z;
  const k=1/(1+drone.z*0.7);
  shadowMesh.material.opacity=.4*k;
  shadowMesh.scale.setScalar(1+drone.z*0.25);
  pwrSprite.visible=!drone.motors && viewMode!=='fpv';
  pwrSprite.position.copy(droneGrp.position).add(new THREE.Vector3(0,0.35,0));
}

/* =========================================================
   POOLS — R.list 指令對應的 3D 物件
   ========================================================= */
function initPools(){
  makePool('ring',()=>{
    const root=new THREE.Group();
    const ring=new THREE.Mesh(new THREE.RingGeometry(0.92,1,48),
      new THREE.MeshBasicMaterial({transparent:true,side:THREE.DoubleSide,depthWrite:false}));
    ring.rotation.x=-Math.PI/2; ring.position.y=0.02; ring.renderOrder=6;
    const fill=new THREE.Mesh(new THREE.CircleGeometry(0.92,48),
      new THREE.MeshBasicMaterial({transparent:true,opacity:.08,depthWrite:false}));
    fill.rotation.x=-Math.PI/2; fill.position.y=0.015; fill.renderOrder=5;
    const pillar=new THREE.Mesh(new THREE.CylinderGeometry(1,1,1,36,1,true),
      new THREE.MeshBasicMaterial({transparent:true,opacity:.06,side:THREE.DoubleSide,depthWrite:false}));
    pillar.scale.y=2.2; pillar.position.y=1.1; pillar.renderOrder=25;
    root.add(ring,fill,pillar);
    return {root,ring,fill,pillar};
  });
  makePool('arc',()=>{
    const mesh=new THREE.Mesh(new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({transparent:true,side:THREE.DoubleSide,depthWrite:false}));
    mesh.rotation.x=-Math.PI/2; mesh.scale.x=-1;  // 鏡射 → 由北順時針
    mesh.position.y=0.035; mesh.renderOrder=7;
    return {root:mesh,key:''};
  });
  makePool('ray',()=>{
    const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),
      new THREE.LineDashedMaterial({dashSize:.12,gapSize:.09,transparent:true}));
    line.renderOrder=8;
    return {root:line};
  });
  makePool('corridor',()=>{
    const root=new THREE.Group();
    const fill=new THREE.Mesh(new THREE.PlaneGeometry(1,1),
      new THREE.MeshBasicMaterial({color:0x4fa8ff,transparent:true,opacity:.06,depthWrite:false}));
    fill.rotation.x=-Math.PI/2; fill.position.y=0.01; fill.renderOrder=3;
    const edges=new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({color:0x4fa8ff,transparent:true,opacity:.4,dashSize:.12,gapSize:.1}));
    edges.position.y=0.012; edges.renderOrder=4;
    root.add(fill,edges);
    return {root,fill,edges,key:''};
  });
  makePool('square',()=>{
    const line=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
      [V(-1,1,0),V(1,1,0),V(1,-1,0),V(-1,-1,0)]),
      new THREE.LineDashedMaterial({dashSize:.14,gapSize:.11,transparent:true}));
    line.computeLineDistances(); line.position.y=0.014; line.renderOrder=4;
    return {root:line};
  });
  makePool('ellipse',()=>{
    const line=new THREE.LineLoop(new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({dashSize:.12,gapSize:.1,transparent:true}));
    line.position.y=0.014; line.renderOrder=4;
    return {root:line,key:''};
  });
  makePool('zoneRect',()=>{
    const root=new THREE.Group();
    const fill=new THREE.Mesh(new THREE.PlaneGeometry(1,1),
      new THREE.MeshBasicMaterial({transparent:true,depthWrite:false}));
    fill.rotation.x=-Math.PI/2; fill.position.y=0.009; fill.renderOrder=3;
    const solid=new THREE.LineLoop(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({transparent:true}));
    solid.position.y=0.013; solid.renderOrder=4;
    const dashed=new THREE.LineLoop(new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({dashSize:.12,gapSize:.1,transparent:true}));
    dashed.position.y=0.013; dashed.renderOrder=4;
    root.add(fill,solid,dashed);
    return {root,fill,solid,dashed,key:''};
  });
  makePool('line',()=>{
    const root=new THREE.Group();
    const solid=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),
      new THREE.LineBasicMaterial({transparent:true}));
    const dashed=new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(),new THREE.Vector3()]),
      new THREE.LineDashedMaterial({dashSize:.1,gapSize:.08,transparent:true}));
    solid.renderOrder=8; dashed.renderOrder=8;
    root.add(solid,dashed);
    return {root,solid,dashed};
  });
  makePool('text',()=>{
    const sp=createTextSprite(320,80,1.5);
    return {root:sp};
  });
  makePool('pylon',()=>{
    const root=new THREE.Group();
    const pole=new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.06,1.3,12),
      new THREE.MeshLambertMaterial({color:0xa78bfa}));
    pole.position.y=0.65; pole.castShadow=true;
    const cap=new THREE.Mesh(new THREE.SphereGeometry(0.08,12,10),
      new THREE.MeshBasicMaterial({color:0xa78bfa}));
    cap.position.y=1.32; cap.castShadow=true;
    const base=new THREE.Mesh(new THREE.RingGeometry(0.1,0.15,24),
      new THREE.MeshBasicMaterial({color:0xa78bfa,transparent:true,opacity:.5,side:THREE.DoubleSide,depthWrite:false}));
    base.rotation.x=-Math.PI/2; base.position.y=0.018; base.renderOrder=5;
    root.add(pole,cap,base);
    return {root};
  });
  makePool('goal',()=>{
    const root=new THREE.Group();
    const mat=new THREE.MeshLambertMaterial({color:0xe9f1f7});
    const H=2.1;
    [-0.8,0.8].forEach(x=>{
      const post=new THREE.Mesh(new THREE.CylinderGeometry(0.025,0.025,H,10),mat);
      post.position.set(x,H/2,0); post.castShadow=true; root.add(post);
    });
    const bar=new THREE.Mesh(new THREE.BoxGeometry(1.65,0.05,0.05),mat);
    bar.position.set(0,H,0); bar.castShadow=true; root.add(bar);
    // net
    const ncv=document.createElement('canvas'); ncv.width=128; ncv.height=128;
    const nc=ncv.getContext('2d');
    nc.strokeStyle='rgba(233,241,247,.7)'; nc.lineWidth=1;
    for(let k=0;k<=128;k+=12){
      nc.beginPath(); nc.moveTo(k,0); nc.lineTo(k,128); nc.stroke();
      nc.beginPath(); nc.moveTo(0,k); nc.lineTo(128,k); nc.stroke();
    }
    const ntex=new THREE.CanvasTexture(ncv);
    const net=new THREE.Mesh(new THREE.PlaneGeometry(1.6,H),
      new THREE.MeshBasicMaterial({map:ntex,transparent:true,opacity:.22,side:THREE.DoubleSide,depthWrite:false}));
    net.position.set(0,H/2,-0.2); net.renderOrder=26;
    root.add(net);
    return {root};
  });
  makePool('padColor',()=>{
    const root=new THREE.Group();
    const fill=new THREE.Mesh(new THREE.PlaneGeometry(0.68,0.68),
      new THREE.MeshBasicMaterial({transparent:true,depthWrite:false}));
    fill.rotation.x=-Math.PI/2; fill.position.y=0.016; fill.renderOrder=5;
    const border=new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
      [V(-0.34,0.34,0),V(0.34,0.34,0),V(0.34,-0.34,0),V(-0.34,-0.34,0)]),
      new THREE.LineBasicMaterial({transparent:true}));
    border.position.y=0.02; border.renderOrder=6;
    const label=createTextSprite(128,128,0.5);
    label.position.y=0.45;
    root.add(fill,border,label);
    return {root,fill,border,label};
  });
  makePool('ball',()=>{
    const root=new THREE.Group();
    const sph=new THREE.Mesh(new THREE.SphereGeometry(0.1,16,12),
      new THREE.MeshLambertMaterial({color:0xff5c5c}));
    sph.castShadow=true;
    const ringM=new THREE.Mesh(new THREE.TorusGeometry(0.17,0.01,8,32),
      new THREE.MeshBasicMaterial({transparent:true,opacity:.9,depthWrite:false}));
    ringM.rotation.x=Math.PI/2;
    const shadow=new THREE.Mesh(new THREE.CircleGeometry(0.09,16),
      new THREE.MeshBasicMaterial({color:0x000000,transparent:true,opacity:.35,depthWrite:false}));
    shadow.rotation.x=-Math.PI/2; shadow.renderOrder=2;
    root.add(sph,ringM,shadow);
    return {root,sph,ringM,shadow};
  });
  makePool('pad',()=>{
    const cv=document.createElement('canvas'); cv.width=cv.height=128;
    const c=cv.getContext('2d');
    c.strokeStyle='rgba(140,163,184,.95)'; c.lineWidth=6;
    c.strokeRect(8,8,112,112);
    c.beginPath(); c.moveTo(40,64); c.lineTo(88,64); c.stroke();
    c.beginPath(); c.moveTo(64,40); c.lineTo(64,88); c.stroke();
    const tex=new THREE.CanvasTexture(cv);
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(0.56,0.56),
      new THREE.MeshBasicMaterial({map:tex,transparent:true,depthWrite:false}));
    mesh.rotation.x=-Math.PI/2; mesh.position.y=0.011; mesh.renderOrder=3;
    return {root:mesh};
  });
}

/* ---------- consume display list ---------- */
function consume(){
  sweepAll();
  lastBall=null;
  for(const cmd of R.list){
    switch(cmd.t){
      case 'pad':{
        const o=pools.pad.get();
        o.root.position.set(cmd.x,0.011,-cmd.y);
        o.root.material.opacity=.55*cmd.alpha;
        break;
      }
      case 'ring':{
        const o=pools.ring.get(), pc=parseColor(cmd.color);
        o.root.position.set(cmd.x,0,-cmd.y);
        o.root.scale.set(cmd.r,1,cmd.r);
        o.pillar.scale.set(1,2.2/1,1); // 高度不隨半徑縮放(root y-scale=1)
        o.ring.material.color.setHex(pc.c); o.ring.material.opacity=Math.min(.95,pc.a);
        o.fill.material.color.setHex(pc.c); o.fill.material.opacity=.08*pc.a;
        o.pillar.material.color.setHex(pc.c); o.pillar.material.opacity=.07*pc.a;
        break;
      }
      case 'arc':{
        const o=pools.arc.get(), pc=parseColor(cmd.color);
        const key=`${cmd.r}|${Math.round(cmd.f*120)}`;
        if(o.key!==key){
          o.key=key;
          o.root.geometry.dispose();
          o.root.geometry=new THREE.RingGeometry(cmd.r*0.93,cmd.r*1.03,48,1,Math.PI/2,Math.max(0.001,cmd.f*TAU));
        }
        o.root.position.set(cmd.x,0.035,-cmd.y);
        o.root.material.color.setHex(pc.c); o.root.material.opacity=pc.a;
        break;
      }
      case 'ray':{
        const o=pools.ray.get(), pc=parseColor(cmd.color);
        const z=Math.max(drone.z,0.05)+0.16;
        o.root.geometry.setFromPoints([V(drone.x,drone.y,z),
          V(drone.x+Math.sin(cmd.ang)*1.1,drone.y+Math.cos(cmd.ang)*1.1,z)]);
        o.root.computeLineDistances();
        o.root.material.color.setHex(pc.c); o.root.material.opacity=pc.a;
        break;
      }
      case 'corridor':{
        const o=pools.corridor.get();
        const key=cmd.dir+cmd.w;
        if(o.key!==key){
          o.key=key;
          const L=2.15, w=cmd.w;
          if(cmd.dir==='v'){
            o.fill.scale.set(w*2,L*2,1); o.fill.rotation.z=0;
            o.edges.geometry.dispose();
            o.edges.geometry=new THREE.BufferGeometry().setFromPoints(
              [V(-w,-L,0),V(-w,L,0),V(w,-L,0),V(w,L,0)]);
          } else {
            o.fill.scale.set(L*2,w*2,1);
            o.edges.geometry.dispose();
            o.edges.geometry=new THREE.BufferGeometry().setFromPoints(
              [V(-L,-w,0),V(L,-w,0),V(-L,w,0),V(L,w,0)]);
          }
          o.edges.computeLineDistances();
        }
        break;
      }
      case 'square':{
        const o=pools.square.get(), pc=parseColor(cmd.color);
        o.root.scale.set(cmd.half,1,cmd.half);
        o.root.material.color.setHex(pc.c); o.root.material.opacity=pc.a;
        break;
      }
      case 'ellipse':{
        const o=pools.ellipse.get(), pc=parseColor(cmd.color);
        const key=`${cmd.rx}|${cmd.ry}`;
        if(o.key!==key){
          o.key=key;
          const pts=[];
          for(let i=0;i<64;i++){ const a=i/64*TAU; pts.push(V(Math.cos(a)*cmd.rx,Math.sin(a)*cmd.ry,0)); }
          o.root.geometry.dispose();
          o.root.geometry=new THREE.BufferGeometry().setFromPoints(pts);
          o.root.computeLineDistances();
        }
        o.root.position.set(cmd.cx,0.014,-cmd.cy);
        o.root.material.color.setHex(pc.c); o.root.material.opacity=pc.a;
        break;
      }
      case 'zoneRect':{
        const o=pools.zoneRect.get();
        const key=`${cmd.w}|${cmd.h}|${!!cmd.dash}`;
        if(o.key!==key){
          o.key=key;
          const hw=cmd.w/2, hh=cmd.h/2;
          const pts=[V(-hw,hh,0),V(hw,hh,0),V(hw,-hh,0),V(-hw,-hh,0)];
          o.solid.geometry.dispose(); o.solid.geometry=new THREE.BufferGeometry().setFromPoints(pts);
          o.dashed.geometry.dispose(); o.dashed.geometry=new THREE.BufferGeometry().setFromPoints(pts);
          o.dashed.computeLineDistances();
          o.fill.scale.set(cmd.w,cmd.h,1);
        }
        o.root.position.set(cmd.cx,0,-cmd.cy);
        const hasFill=!!cmd.fill, hasStroke=!!cmd.stroke;
        o.fill.visible=hasFill;
        if(hasFill){ const pc=parseColor(cmd.fill); o.fill.material.color.setHex(pc.c); o.fill.material.opacity=pc.a; }
        o.solid.visible=hasStroke&&!cmd.dash;
        o.dashed.visible=hasStroke&&!!cmd.dash;
        if(hasStroke){
          const pc=parseColor(cmd.stroke);
          const ln=cmd.dash?o.dashed:o.solid;
          ln.material.color.setHex(pc.c); ln.material.opacity=pc.a;
        }
        break;
      }
      case 'line':{
        const o=pools.line.get(), pc=parseColor(cmd.color);
        const h=cmd.h!==undefined?cmd.h:0.02;
        const pts=[V(cmd.x1,cmd.y1,h),V(cmd.x2,cmd.y2,h)];
        const ln=cmd.dash?o.dashed:o.solid;
        o.dashed.visible=!!cmd.dash; o.solid.visible=!cmd.dash;
        ln.geometry.setFromPoints(pts);
        if(cmd.dash) ln.computeLineDistances();
        ln.material.color.setHex(pc.c); ln.material.opacity=pc.a;
        break;
      }
      case 'text':{
        const o=pools.text.get();
        setSpriteText(o.root,cmd.txt,cmd.color);
        o.root.position.copy(V(cmd.x,cmd.y,0.35));
        break;
      }
      case 'pylon':{
        const o=pools.pylon.get();
        o.root.position.set(cmd.x,0,-cmd.y);
        break;
      }
      case 'goal':{
        const o=pools.goal.get();
        o.root.position.set(0,0,-cmd.y);
        break;
      }
      case 'padColor':{
        const o=pools.padColor.get(), pc=parseColor(cmd.color);
        o.root.position.set(cmd.x,0,-cmd.y);
        if(cmd.state==='done'){
          o.fill.material.color.setHex(0x4fe3a3); o.fill.material.opacity=.15;
          o.border.material.color.setHex(0x4fe3a3); o.border.material.opacity=.8;
          setSpriteText(o.label,'✓','#4fe3a3');
        } else {
          o.fill.material.color.setHex(pc.c);
          o.fill.material.opacity=cmd.state==='cur'?.35:.15;
          o.border.material.color.setHex(pc.c);
          o.border.material.opacity=cmd.state==='cur'?1:.6;
          setSpriteText(o.label,cmd.label,cmd.state==='cur'?cmd.color:'#5c7186');
        }
        break;
      }
      case 'ball':{
        lastBall=cmd;
        const o=pools.ball.get();
        o.root.position.set(cmd.x,cmd.z,-cmd.y);
        o.sph.material.color.setHex(cmd.live?0xff5c5c:0x8ca3b8);
        o.ringM.visible=!!cmd.live;
        o.ringM.material.color.setHex(cmd.zOk?0x4fe3a3:0xff8a3c);
        o.shadow.position.y=-cmd.z+0.013;
        break;
      }
    }
  }
}

/* =========================================================
   CAMERA
   ========================================================= */
function updateCamera(dt){
  const fwd=new THREE.Vector3(Math.sin(drone.hdg),0,-Math.cos(drone.hdg));
  let tp,tt,up=new THREE.Vector3(0,1,0);
  if(viewMode==='fpv'){
    const eye=V(drone.x,drone.y,Math.max(drone.z,0.02)+0.2).add(fwd.clone().multiplyScalar(0.12));
    camera.position.copy(eye);
    camera.up.set(0,1,0);
    camera.lookAt(eye.clone().add(fwd));
    // 桿量帶動的視角傾斜(FPV 手感)
    camera.rotateZ(-stick.roll*0.1*(drone.motors?1:0));
    camera.rotateX(-stick.pitch*0.06*(drone.motors?1:0));
    camSnap=true;
    return;
  }
  if(viewMode==='chase'){
    tp=V(drone.x,drone.y,drone.z+0.2).sub(fwd.clone().multiplyScalar(1.75)).add(new THREE.Vector3(0,0.8,0));
    tp.y=Math.max(tp.y,0.25);
    tt=V(drone.x,drone.y,drone.z+0.2).add(fwd.clone().multiplyScalar(0.5));
  } else if(viewMode==='goal'){
    // 球門後上方定點,可同時看到守門機與全場來球
    tp=V(0,4.1,3.0);
    tt=V(drone.x*0.35,-0.4,0.7);
  } else { // top
    tp=new THREE.Vector3(0,7.6,0.001);
    tt=new THREE.Vector3(0,0,0);
    up=new THREE.Vector3(0,0,-1);   // 北在畫面上方,與 2D 版一致
  }
  const k=camSnap?1:1-Math.exp(-9*dt);
  camSnap=false;
  camPos.lerp(tp,k); camTgt.lerp(tt,k);
  camera.position.copy(camPos);
  camera.up.copy(up);
  camera.lookAt(camTgt);
}

/* =========================================================
   HUD(2D overlay:高度尺 / 指南針 / FPV 準星)
   ========================================================= */
function drawHUD(){
  const g=hudCtx, W=hudW, H=hudH;
  g.clearRect(0,0,W,H);
  if(scene!=='play'&&scene!=='brief'&&scene!=='done') return;
  const s=clamp(H/560,.72,1.5), lw=v=>v*s;
  /* ---- altitude ladder (right edge) ---- */
  {
    const X=W-lw(36), top=lw(46), bot=H-lw(26), LH=bot-top, maxZ=2.6;
    const zy=z=>bot-(z/maxZ)*LH;
    g.save();
    g.fillStyle='rgba(13,21,32,.72)';
    g.fillRect(X-lw(14),top-lw(14),lw(46),LH+lw(28));
    g.strokeStyle='#223148'; g.strokeRect(X-lw(14),top-lw(14),lw(46),LH+lw(28));
    if(altBand){
      g.fillStyle=altBand.shuttle?'rgba(79,168,255,.2)':'rgba(79,227,163,.2)';
      g.fillRect(X-lw(9),zy(altBand.b),lw(18),zy(altBand.a)-zy(altBand.b));
      g.strokeStyle=altBand.shuttle?'rgba(79,168,255,.6)':'rgba(79,227,163,.6)'; g.lineWidth=1;
      g.strokeRect(X-lw(9),zy(altBand.b),lw(18),zy(altBand.a)-zy(altBand.b));
    }
    g.strokeStyle='#3c4f68'; g.lineWidth=1; g.fillStyle='#8ca3b8';
    g.font=`${lw(10)}px Consolas,monospace`; g.textAlign='right';
    for(let z=0;z<=2.5;z+=0.5){
      g.beginPath(); g.moveTo(X-lw(4),zy(z)); g.lineTo(X+lw(4),zy(z)); g.stroke();
      g.fillText(z.toFixed(1),X-lw(8),zy(z)+lw(3));
    }
    const inB=altBand&&drone.z>=altBand.a&&drone.z<=altBand.b;
    g.fillStyle=inB?'#4fe3a3':(altBand?'#ff8a3c':'#4fe3a3');
    const my=zy(clamp(drone.z,0,maxZ));
    g.beginPath();
    g.moveTo(X+lw(15),my); g.lineTo(X+lw(7),my-lw(5)); g.lineTo(X+lw(7),my+lw(5));
    g.closePath(); g.fill();
    g.fillStyle='#8ca3b8'; g.font=`${lw(9)}px Consolas,monospace`;
    g.save(); g.translate(X+lw(26),top+LH/2); g.rotate(-Math.PI/2); g.textAlign='center';
    g.fillText('ALTITUDE m',0,0); g.restore();
    g.restore();
  }
  /* ---- compass tape (top center) ---- */
  {
    const y=lw(22), w=Math.min(W*0.4,420*s), x0=W/2-w/2;
    g.save();
    g.fillStyle='rgba(13,21,32,.72)'; g.fillRect(x0,y-lw(13),w,lw(28));
    g.strokeStyle='#223148'; g.strokeRect(x0,y-lw(13),w,lw(28));
    g.beginPath(); g.rect(x0,y-lw(13),w,lw(28)); g.clip();
    const deg=(drone.hdg*180/Math.PI%360+360)%360;
    const names={0:'前',90:'右',180:'後',270:'左'};
    g.font=`${lw(11)}px "Microsoft JhengHei",Consolas,monospace`; g.textAlign='center';
    for(let d=-120;d<=120;d+=15){
      let a=Math.round((deg+d)/15)*15; const off=(a-deg+540)%360-180;
      const xx=W/2+off*(w/240); const am=((a%360)+360)%360;
      if(Math.abs(off)>120) continue;
      if(am%90===0){ g.fillStyle='#ff8a3c'; g.fillText(names[am],xx,y+lw(7));
        g.strokeStyle='#ff8a3c'; g.beginPath(); g.moveTo(xx,y-lw(12)); g.lineTo(xx,y-lw(6)); g.stroke(); }
      else{ g.fillStyle='#5c7186'; g.strokeStyle='#3c4f68';
        g.beginPath(); g.moveTo(xx,y-lw(12)); g.lineTo(xx,y-lw(8)); g.stroke(); }
    }
    g.restore();
    g.fillStyle='#4fe3a3';
    g.beginPath(); g.moveTo(W/2,y+lw(17)); g.lineTo(W/2-lw(5),y+lw(23)); g.lineTo(W/2+lw(5),y+lw(23));
    g.closePath(); g.fill();
  }
  /* ---- FPV crosshair ---- */
  if(viewMode==='fpv'){
    g.save();
    g.strokeStyle='rgba(79,227,163,.75)'; g.lineWidth=lw(1.6);
    const cx=W/2, cy=H/2, r=lw(14);
    g.beginPath(); g.arc(cx,cy,r,0,TAU); g.stroke();
    [[-1,0],[1,0],[0,-1],[0,1]].forEach(d=>{
      g.beginPath(); g.moveTo(cx+d[0]*(r+lw(2)),cy+d[1]*(r+lw(2)));
      g.lineTo(cx+d[0]*(r+lw(9)),cy+d[1]*(r+lw(9))); g.stroke();
    });
    g.restore();
    // 地面高度提示(FPV 看不到腳下)
    if(drone.z<0.6&&drone.z>0.02){
      g.fillStyle='rgba(255,138,60,.9)'; g.font=`700 ${lw(12)}px "Microsoft JhengHei",sans-serif`;
      g.textAlign='center';
      g.fillText(`▼ 離地 ${drone.z.toFixed(2)}m`,W/2,H-lw(26));
    }
  }
  /* ---- 來球方向箭頭(球在畫面外/背後時,FPV 與追機視角) ---- */
  if(lastBall&&lastBall.live&&(viewMode==='fpv'||viewMode==='chase')){
    const bw=V(lastBall.x,lastBall.y,lastBall.z);
    const ndc=bw.clone().project(camera);
    const camDir=camera.getWorldDirection(new THREE.Vector3());
    const toBall=bw.clone().sub(camera.position);
    const behind=camDir.dot(toBall)<0;
    let sx=(ndc.x+1)/2*W, sy=(1-ndc.y)/2*H;
    if(behind){ sx=W-sx; sy=H-sy; }   // 背後時鏡射到正確方向
    const off=behind||sx<0||sx>W||sy<0||sy>H||Math.abs(ndc.x)>0.92||Math.abs(ndc.y)>0.88;
    if(off){
      // 從畫面中心朝球方向,箭頭貼齊邊緣
      const dx=sx-W/2, dy=sy-H/2, m=Math.max(Math.abs(dx)/(W/2-lw(34)),Math.abs(dy)/(H/2-lw(34)),0.0001);
      const ax=W/2+dx/m, ay=H/2+dy/m, ang=Math.atan2(dy,dx);
      const dist=toBall.length();
      g.save();
      g.translate(ax,ay); g.rotate(ang);
      g.fillStyle='rgba(255,92,92,.95)';
      g.beginPath(); g.moveTo(lw(15),0); g.lineTo(-lw(7),-lw(9)); g.lineTo(-lw(7),lw(9));
      g.closePath(); g.fill();
      g.rotate(-ang);
      g.font=`700 ${lw(11)}px "Microsoft JhengHei",sans-serif`; g.textAlign='center';
      g.fillText(`來球 ${dist.toFixed(1)}m`,0,lw(24));
      g.restore();
    }
  }
}

/* =========================================================
   PUBLIC
   ========================================================= */
function setView(m){
  viewMode=m; camSnap=true;
  const b=$('btnView');
  if(b) b.textContent=`📷 ${VIEW_NAMES[m]}(V)`;
}
function cycleView(){
  setView(VIEW_ORDER[(VIEW_ORDER.indexOf(viewMode)+1)%VIEW_ORDER.length]);
}
function resize(){
  if(!renderer) return;
  const r=container.getBoundingClientRect();
  if(r.width<2) return;
  const dpr=Math.min(2,window.devicePixelRatio||1);
  renderer.setPixelRatio(dpr);
  renderer.setSize(r.width,r.height,false);
  if(composer){ composer.setPixelRatio(dpr); composer.setSize(r.width,r.height); }
  camera.aspect=r.width/r.height;
  camera.updateProjectionMatrix();
  hudW=r.width; hudH=r.height;
  hudCv.width=Math.round(r.width*dpr); hudCv.height=Math.round(r.height*dpr);
  hudCtx.setTransform(dpr,0,0,dpr,0,0);
}
function init(){
  glCv=$('cv'); hudCv=$('hud'); hudCtx=hudCv.getContext('2d');
  container=glCv.parentElement;
  renderer=new THREE.WebGLRenderer({canvas:glCv,antialias:true});
  renderer.setClearColor(0x0a0f16);
  renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  scene3=new THREE.Scene();
  scene3.fog=new THREE.Fog(0x0a0f16,7,15);
  camera=new THREE.PerspectiveCamera(72,16/10,0.02,60);
  // Bloom 後製鏈(three-post.js 未載入時自動退回直接渲染)
  try{
    if(THREE.EffectComposer&&THREE.UnrealBloomPass){
      const rt=new THREE.WebGLRenderTarget(4,4,{depthBuffer:true,stencilBuffer:false});
      rt.samples=4;   // WebGL2 MSAA;WebGL1 自動忽略
      composer=new THREE.EffectComposer(renderer,rt);
      composer.addPass(new THREE.RenderPass(scene3,camera));
      bloomPass=new THREE.UnrealBloomPass(new THREE.Vector2(4,4),0.42,0.4,0.68);
      composer.addPass(bloomPass);
    }
  }catch(e){ composer=null; }
  buildArena();
  buildScenery();
  buildDrone();
  buildParticles();
  window.addEventListener('resize',resize);
  const b=$('btnView');
  if(b) b.addEventListener('click',cycleView);
  const bs=$('btnScenery');
  if(bs) bs.addEventListener('click',toggleScenery);
  try{ sceneryOn=localStorage.getItem('ds3Scenery')!=='0'; }catch(e){}
  applyScenery();
  initPools();
  setView(viewMode);
  resize();
}
function render(dt){
  if(!renderer) return;
  droneGrp.visible=viewMode!=='fpv';
  shadowMesh.visible=viewMode!=='fpv';
  consume();
  updateDrone(dt);
  updateParticles(dt);
  updateCamera(dt);
  if(sceneryOn&&composer) composer.render();
  else renderer.render(scene3,camera);
  drawHUD();
}
return {init,render,resize,setView,cycleView,get viewMode(){return viewMode;}};
})();
