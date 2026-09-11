import { DurableObject } from "cloudflare:workers";

const FIREBASE_BASE = "https://bunka-ca0b7-default-rtdb.asia-southeast1.firebasedatabase.app/festivalStockGame";
const ENGINE_ID = "cloudflare-stock-engine";
const ALARM_MS = 2500;
const INITIAL_PRICE = 200;
const MIN_PRICE = 50;
const EFFECT_SECONDS = 120;
const MAX_TRADE_EFFECT = 100;
const MAX_COMBINED_EFFECT = 150;

const MARKET_PROFILES = [
  {meanTarget:290,preferredMin:200,preferredMax:380,meanStrength:0.00020,volatility:0.035,momentumKeep:0.82,maxMomentum:0.055,newsUpMultiplier:0.40,newsDownMultiplier:0.40,floorSupport:1.9},
  {meanTarget:950,preferredMin:800,preferredMax:1100,meanStrength:0.00125,volatility:0.045,momentumKeep:0.76,maxMomentum:0.30,newsUpMultiplier:0.90,newsDownMultiplier:0.62,floorSupport:2.35,mixedVolatility:true},
  {meanTarget:1250,preferredMin:1000,preferredMax:1500,meanStrength:0.00110,volatility:0.026,momentumKeep:0.84,maxMomentum:0.24,newsUpMultiplier:0.62,newsDownMultiplier:0.48,floorSupport:2.65,rareMove:true},
  {meanTarget:300,preferredMin:180,preferredMax:480,meanStrength:0.00020,volatility:0.055,momentumKeep:0.56,maxMomentum:0.16,newsUpMultiplier:0.22,newsDownMultiplier:0.22,floorSupport:1.75,regimeSwitch:true}
];

const DEFAULT_STOCKS = [
  {name:"ãã£ã¼ã1",lineColor:"#ff3b30",minuteMoveLimit:100,minPrice:50,news:[
    {text:"ç¤¾é·ã®ä¸ç¥¥äºãçºè¦",direction:"down",min:50,max:150,probability:100},
    {text:"ãã­ã¼ã©ã¤ããçºè¦",direction:"up",min:50,max:150,probability:100},
    {text:"æçã«ããºãæ··å¥",direction:"down",min:50,max:150,probability:100}
  ]},
  {name:"ãã£ã¼ã2",lineColor:"#ff9f40",minuteMoveLimit:100,minPrice:50,news:[
    {text:"èã£ã¦ããã³ãæä¾ãçä¸",direction:"down",min:70,max:120,probability:100},
    {text:"ã¤ã³ã¹ã¿ã§ååãããºã",direction:"up",min:60,max:140,probability:100},
    {text:"ãã³ãç¡¬ããã¦æ­¯ãæ¬ ãã",direction:"down",min:70,max:120,probability:100}
  ]},
  {name:"ãã£ã¼ã3",lineColor:"#00d084",minuteMoveLimit:100,minPrice:50,news:[
    {text:"ãã¶ã®ãã¼ãºãèã£ã¦ã",direction:"down",min:80,max:140,probability:100},
    {text:"ãã¬ãã§ç´¹ä»ããã",direction:"up",min:120,max:160,probability:100},
    {text:"ã¦ã¤ã«ã¹ã§å®¢ãæ¥ãªã",direction:"down",min:80,max:140,probability:100}
  ]},
  {name:"ãã£ã¼ã4",lineColor:"#b87cff",minuteMoveLimit:100,minPrice:50,news:[
    {text:"éå½ã¢ã¤ãã«ãç±æ",direction:"down",min:100,max:160,probability:100},
    {text:"éå½ã®ã©ã¼ã¡ã³ãæµè¡ã",direction:"up",min:50,max:200,probability:100},
    {text:"ã¢ã¤ãã«ãå¾´åµã«è¡ã",direction:"down",min:100,max:160,probability:100}
  ]}
];

const rint=(a,b)=>Math.floor(Math.random()*(b-a+1))+a;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const round1=v=>Math.round((Number(v)||0)*10)/10;
const fmt=v=>String(round1(v));
const getMarketProfile=i=>MARKET_PROFILES[clamp(Number(i)||0,0,3)];
const notificationTokenForNews=(sourceStockIndex,key)=>`${Number(sourceStockIndex)}:${String(key)}`;

function jstDateKey(ms=Date.now()){
  const d=new Date(Number(ms)+9*60*60*1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}
function jstHourStartMs(ms=Date.now()){
  const d=new Date(Number(ms)+9*60*60*1000);
  return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCHours())-9*60*60*1000;
}
function firebaseKey(value){
  return encodeURIComponent(String(value??"")).replace(/\./g,"%2E");
}

async function fbGet(path){
  const res=await fetch(`${FIREBASE_BASE}/${path}.json`,{headers:{"cache-control":"no-cache"}});
  if(!res.ok)throw new Error(`Firebase GET ${path}: ${res.status}`);
  return await res.json();
}
async function fbPatch(updates){
  const res=await fetch(`${FIREBASE_BASE}.json`,{
    method:"PATCH",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(updates)
  });
  if(!res.ok)throw new Error(`Firebase PATCH: ${res.status} ${await res.text()}`);
}

function getStockSetting(i,s,stockSettings){
  const cfg=stockSettings?.[i]||stockSettings?.[String(i)]||{};
  return{
    name:cfg.name??s?.name??DEFAULT_STOCKS[i]?.name??`ãã£ã¼ã${i+1}`,
    minuteMoveLimit:Number(cfg.minuteMoveLimit??s?.minuteMoveLimit??100),
    minPrice:Number(cfg.minPrice??s?.minPrice??MIN_PRICE)
  };
}
function defaultStock(def,now){
  return{
    name:def.name,lineColor:def.lineColor,minuteMoveLimit:Number(def.minuteMoveLimit)||100,minPrice:Number(def.minPrice)||50,
    minuteBucket:Math.floor(now/60000),minuteStartPrice:INITIAL_PRICE,news:structuredClone(def.news),price:INITIAL_PRICE,
    lastNewsIndex:-1,newsEvents:[],activeEffects:[],hourlyPriceRanges:[{minute:Math.floor(now/60000),min:INITIAL_PRICE,max:INITIAL_PRICE}],
    points:Array(30).fill(INITIAL_PRICE),labels:Array.from({length:30},(_,i)=>`-${30-i}ç§`),lastTick:now
  };
}
function newsEntries(s){
  return Object.entries(s?.news||{}).filter(([,n])=>n&&n.text);
}
function remaining(s,kind){
  return (s.activeEffects||[]).filter(e=>!kind||e.kind===kind).reduce((a,e)=>a+(Number(e.remaining)||0),0);
}
function limitCombined(s,x){
  const old=remaining(s);
  return round1(clamp(old+x,-MAX_COMBINED_EFFECT,MAX_COMBINED_EFFECT)-old);
}
function limitTrade(s,x){
  const old=remaining(s,"trade");
  const allowed=clamp(old+x,-MAX_TRADE_EFFECT,MAX_TRADE_EFFECT)-old;
  return limitCombined(s,allowed);
}
function normalizedNewsEffects(sourceStockIndex,n){
  const result={};
  if(n?.effects&&typeof n.effects==="object"){
    for(const [k,v] of Object.entries(n.effects)){
      const i=Number(k);
      if(!Number.isInteger(i)||i<0||i>3||!v)continue;
      const direction=String(v.direction||"");
      if(!["up","down"].includes(direction))continue;
      const min=Math.max(0,Number(v.min)||0),max=Math.max(min,Number(v.max)||min);
      result[i]={direction,min,max};
    }
  }
  if(!Object.keys(result).length&&n&&["up","down"].includes(String(n.direction))){
    const min=Math.max(0,Number(n.min)||0),max=Math.max(min,Number(n.max)||min);
    result[sourceStockIndex]={direction:String(n.direction),min,max};
  }
  return result;
}
function primaryNewsDirection(sourceStockIndex,n){
  const effects=normalizedNewsEffects(sourceStockIndex,n);
  return effects[sourceStockIndex]?.direction||Object.values(effects)[0]?.direction||"";
}
function allGlobalNewsEntries(stockList){
  const list=[];
  stockList.forEach((st,sourceStockIndex)=>{
    newsEntries(st).forEach(([key,news])=>list.push({token:`${sourceStockIndex}:${key}`,sourceStockIndex,key:String(key),news}));
  });
  return list;
}
const globalNewsDelay=()=>rint(20,35)*1000;
function globalNewsWeight(item,stockList){
  let weight=Math.max(0,Number(item.news?.probability??100));
  const effects=normalizedNewsEffects(item.sourceStockIndex,item.news);
  for(const [k,effect] of Object.entries(effects)){
    const i=Number(k),st=stockList[i]; if(!st)continue;
    const profile=getMarketProfile(i),current=Number(st.price)||INITIAL_PRICE;
    const pmin=Number(profile.preferredMin),pmax=Number(profile.preferredMax);
    let factor=1;
    if(effect.direction==="up"&&Number.isFinite(pmax)&&current>pmax){const over=(current-pmax)/Math.max(1,pmax);factor=Math.max(0.08,0.30-over*0.8)}
    if(effect.direction==="down"&&Number.isFinite(pmin)&&current<pmin){const under=(pmin-current)/Math.max(1,pmin);factor=Math.max(0.08,0.30-under*0.8)}
    weight*=factor;
  }
  return Math.max(0,weight);
}
function chooseGlobalNews(stockList,control={}){
  let candidates=allGlobalNewsEntries(stockList); if(!candidates.length)return null;
  const lastToken=String(control.lastNewsToken||"");
  const withoutLast=candidates.filter(x=>x.token!==lastToken); if(withoutLast.length)candidates=withoutLast;
  const lastDirection=String(control.lastDirection||""),streak=Number(control.directionStreak)||0;
  if(streak>=2&&["up","down"].includes(lastDirection)){
    const opposite=candidates.filter(x=>primaryNewsDirection(x.sourceStockIndex,x.news)!==lastDirection);
    if(opposite.length)candidates=opposite;
  }
  const weights=candidates.map(x=>globalNewsWeight(x,stockList)),total=weights.reduce((a,b)=>a+b,0);
  if(total<=0)return candidates[rint(0,candidates.length-1)];
  let roll=Math.random()*total;
  for(let i=0;i<candidates.length;i++){roll-=weights[i];if(roll<=0)return candidates[i]}
  return candidates[candidates.length-1];
}
function adjustedNewsEffect(st,stockIndex,effect){
  const isDown=effect.direction==="down",min=Math.max(0,Number(effect.min)||0),max=Math.max(min,Number(effect.max)||min);
  const profile=getMarketProfile(stockIndex); let multiplier=isDown?profile.newsDownMultiplier:profile.newsUpMultiplier;
  const current=Number(st.price)||INITIAL_PRICE,pmin=Number(profile.preferredMin),pmax=Number(profile.preferredMax);
  if(!isDown&&Number.isFinite(pmax)&&current>pmax){const over=(current-pmax)/Math.max(1,pmax);multiplier*=Math.max(0.15,0.35-over*0.7)}
  if(isDown&&Number.isFinite(pmin)&&current<pmin){const under=(pmin-current)/Math.max(1,pmin);multiplier*=Math.max(0.15,0.35-under*0.7)}
  const amount=Math.max(0,round1(rint(min,max)*multiplier));
  return isDown?-amount:amount;
}
function newsEffectsSummary(sourceStockIndex,n,stockList,stockSettings){
  const effects=normalizedNewsEffects(sourceStockIndex,n),parts=[];
  for(let i=0;i<4;i++){
    const e=effects[i]; if(!e)continue;
    const name=getStockSetting(i,stockList[i],stockSettings).name;
    parts.push(`${name} ${e.direction==="up"?"ä¸æ":"ä¸é"} ${fmt(e.min)}ã${fmt(e.max)}å`);
  }
  return parts.join(" ï¼ ")||"æ ªä¾¡ã¸ã®ç´æ¥å¹æãªã";
}
function applyGlobalNewsToStocks(stockList,item,stockSettings,createdAt=Date.now()){
  if(!item?.news)return null;
  const d=item.news,sourceStockIndex=Number(item.sourceStockIndex),effects=normalizedNewsEffects(sourceStockIndex,d);
  const id=`global-news-${ENGINE_ID}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const text=String(d.text||"ãã¥ã¼ã¹"),sourceCountry=getStockSetting(sourceStockIndex,stockList[sourceStockIndex],stockSettings).name;
  const summary=newsEffectsSummary(sourceStockIndex,d,stockList,stockSettings);
  for(let i=0;i<4;i++){
    const st=stockList[i]; if(!st)continue;
    st.newsEvents=Array.isArray(st.newsEvents)?st.newsEvents:[]; st.activeEffects=Array.isArray(st.activeEffects)?st.activeEffects:[];
    const effect=effects[i]; let rawEffect=0,allowed=0;
    if(effect){
      rawEffect=adjustedNewsEffect(st,i,effect); allowed=limitCombined(st,rawEffect);
      const oldDirection=String(st.newsDirectionStreak?.direction||""),oldCount=Number(st.newsDirectionStreak?.count)||0;
      st.newsDirectionStreak={direction:effect.direction,count:oldDirection===effect.direction?oldCount+1:1};
    }
    const ev={id,text,sourceCountry,sourceStockIndex,sourceNewsKey:String(item.key||""),newsToken:String(item.token||notificationTokenForNews(sourceStockIndex,item.key)),effectsSummary:summary,unaffected:!effect,display:text,finished:!effect||allowed===0,requestedEffect:rawEffect,targetEffect:allowed,applied:0,createdAt};
    if(!effect)ev.display=`${text}ï¼ãã®ãã£ã¼ãã¸ã®å½±é¿ãªãï¼`;
    else if(allowed===0)ev.display=`${text}ï¼0åï¼`;
    st.newsEvents=[ev,...st.newsEvents].slice(0,100); st.lastNewsIndex=item.token;
    if(effect&&allowed!==0)st.activeEffects.push({kind:"news",eventId:id,direction:effect.direction,totalEffect:allowed,remaining:allowed,applied:0,secondsLeft:EFFECT_SECONDS});
  }
  return{id,text,sourceCountry,summary,direction:primaryNewsDirection(sourceStockIndex,d)};
}

function backgroundMarketStep(s,tickTime,cfg,stockIndex){
  const profile=getMarketProfile(stockIndex),current=Number(s.price)||INITIAL_PRICE;
  const minPrice=Math.max(0,Number(cfg.minPrice??s.minPrice??MIN_PRICE));
  let volatility=Number(profile.volatility)||0.03;
  if(profile.mixedVolatility){volatility=Math.random()<0.22?0.11+Math.random()*0.10:0.018+Math.random()*0.035}
  let randomImpulse=(Math.random()*2-1)*volatility;
  const pmin=Number(profile.preferredMin),pmax=Number(profile.preferredMax);
  if(Number.isFinite(pmax)&&current>pmax&&randomImpulse>0){randomImpulse*=0.20;if(Math.random()<0.70)randomImpulse=0}
  if(Number.isFinite(pmin)&&current<pmin&&randomImpulse<0){randomImpulse*=0.20;if(Math.random()<0.70)randomImpulse=0}
  if(profile.rareMove&&Math.random()<0.0012){
    if(Math.random()<0.52)randomImpulse=-Math.max(Math.abs(randomImpulse),volatility)*(2+Math.random());
    else randomImpulse=Math.max(Math.abs(randomImpulse),volatility)*(1.2+Math.random()*0.6);
  }
  let regimeBias=0;
  if(profile.regimeSwitch){
    const n=Number(tickTime)||Date.now();
    if(!s.marketRegime||Number(s.marketRegimeUntil||0)<=n){const roll=Math.random();s.marketRegime=roll<0.38?"up":roll<0.76?"down":"flat";s.marketRegimeUntil=n+rint(8,24)*1000}
    if(s.marketRegime==="up")regimeBias=0.055+Math.random()*0.045;
    else if(s.marketRegime==="down")regimeBias=-(0.055+Math.random()*0.045);
    else regimeBias=(Math.random()*2-1)*0.012;
    if(Math.random()<0.018)s.marketRegimeUntil=n;
  }
  const oldMomentum=Number(s.naturalMomentum)||0;
  let momentum=oldMomentum*(Number(profile.momentumKeep)||0.75)+randomImpulse+regimeBias;
  const maxMomentum=Number(profile.maxMomentum)||0.1;
  momentum=clamp(momentum,-maxMomentum,maxMomentum);
  let target=Number(profile.meanTarget)||INITIAL_PRICE,meanStrength=Number(profile.meanStrength)||0.0001;
  const softFloor=Math.max(minPrice*Number(profile.floorSupport||1.5),minPrice+20);
  if((stockIndex===1||stockIndex===2)&&pmin>0&&pmax>0){
    const n=Number(tickTime)||Date.now();
    if(!s.rangeEscapeUntil||Number(s.rangeEscapeUntil)<=n){
      if(Math.random()<0.00045){s.rangeEscapeUntil=n+rint(25,70)*1000;s.rangeEscapeDirection=Math.random()<0.5?"up":"down"}
      else{s.rangeEscapeUntil=0;s.rangeEscapeDirection=""}
    }
    const escaping=Number(s.rangeEscapeUntil)>n;
    if(escaping){
      meanStrength*=0.08;
      if(s.rangeEscapeDirection==="up"){let extra=stockIndex===1?0.18:0.22;if(current>pmax){const over=(current-pmax)/Math.max(1,pmax);extra*=Math.max(0.15,1-over*2.5)}momentum+=extra}
      else{let extra=stockIndex===1?0.16:0.20;if(current<pmin){const under=(pmin-current)/Math.max(1,pmin);extra*=Math.max(0.15,1-under*2.5)}momentum-=extra}
    }else{
      if(current<pmin){target=(pmin+pmax)/2;meanStrength*=stockIndex===1?4.2:4.8}
      else if(current>pmax){target=(pmin+pmax)/2;meanStrength*=stockIndex===1?3.6:4.1}
      else{target=(pmin+pmax)/2;meanStrength*=0.18}
    }
  }else if(current<softFloor&&current<target)meanStrength*=2.7;
  momentum+=(target-current)*meanStrength;
  if(stockIndex===1&&pmin>0&&current<pmin*0.65)momentum+=0.13;
  if(stockIndex===2&&pmin>0&&current<pmin*0.65)momentum+=0.16;
  momentum=clamp(momentum,-maxMomentum,maxMomentum); s.naturalMomentum=momentum;
  let carry=Number(s.naturalCarry)||0; carry+=momentum; let emitted=0;
  if(Math.abs(carry)>=0.1){emitted=Math.trunc(carry*10)/10;carry-=emitted}
  s.naturalCarry=carry; return emitted;
}
function updateHourlyPriceRange(s,price,at=Date.now()){
  const minute=Math.floor(Number(at)/60000),value=Number(price); if(!Number.isFinite(value))return;
  s.hourlyPriceRanges=Array.isArray(s.hourlyPriceRanges)?s.hourlyPriceRanges:[];
  let bucket=s.hourlyPriceRanges.find(x=>Number(x?.minute)===minute);
  if(!bucket){bucket={minute,min:value,max:value};s.hourlyPriceRanges.push(bucket)}
  else{bucket.min=Math.min(Number(bucket.min??value),value);bucket.max=Math.max(Number(bucket.max??value),value)}
  s.hourlyPriceRanges=s.hourlyPriceRanges.filter(x=>Number(x?.minute)>=minute-59&&Number(x?.minute)<=minute).sort((a,b)=>Number(a.minute)-Number(b.minute)).slice(-60);
}
function processStock(s,tickTime,cfg={},stockIndex=0){
  let effects=(Array.isArray(s.activeEffects)?s.activeEffects:[]).filter(e=>Number(e.secondsLeft)>0&&Math.abs(Number(e.remaining)||0)>0.000001);
  const minPrice=Math.max(0,Number(cfg.minPrice??s.minPrice??MIN_PRICE)),minuteLimit=Math.max(0,Number(cfg.minuteMoveLimit??s.minuteMoveLimit??100));
  const minute=Math.floor(Number(tickTime)/60000);
  if(s.minuteBucket!==minute){s.minuteBucket=minute;s.minuteStartPrice=Number(s.price)||INITIAL_PRICE}
  if(!Number.isFinite(Number(s.minuteStartPrice)))s.minuteStartPrice=Number(s.price)||INITIAL_PRICE;
  let effectRequestedStep=0;
  for(const e of effects){
    const seconds=Math.max(1,Number(e.secondsLeft)||1); let rem=Number(e.remaining)||0;
    if(e.kind==="news"){rem=(e.direction==="down"||Number(e.totalEffect)<0)?-Math.abs(rem):Math.abs(rem);e.remaining=rem}
    let step=rem/seconds;
    if(e.kind==="news")step=(e.direction==="down"||Number(e.totalEffect)<0)?-Math.abs(step):Math.abs(step);
    e._plannedStep=step; effectRequestedStep+=step;
  }
  const current=Number(s.price)||INITIAL_PRICE,backgroundStep=backgroundMarketStep(s,tickTime,cfg,stockIndex);
  const upper=Number(s.minuteStartPrice)+minuteLimit,lower=Math.max(minPrice,Number(s.minuteStartPrice)-minuteLimit);
  let actualStep=effectRequestedStep+backgroundStep;
  if(current+actualStep>upper)actualStep=upper-current;
  if(current+actualStep<lower)actualStep=lower-current;
  if(current+actualStep<minPrice)actualStep=minPrice-current;
  const actualEffectStep=actualStep-backgroundStep; let effectScale=0;
  if(effectRequestedStep!==0&&actualEffectStep*effectRequestedStep>0)effectScale=clamp(Math.abs(actualEffectStep/effectRequestedStep),0,1);
  for(const e of effects){
    const planned=Number(e._plannedStep)||0; let appliedNow=planned*effectScale;
    if(e.kind==="news")appliedNow=(e.direction==="down"||Number(e.totalEffect)<0)?-Math.abs(appliedNow):Math.abs(appliedNow);
    e.applied=(Number(e.applied)||0)+appliedNow;
    if(e.kind==="news"){
      const live=(s.newsEvents||[]).find(x=>x.id===e.eventId); if(live)live.applied=round1(e.applied);
    }
    e.remaining=(Number(e.remaining)||0)-planned; e.secondsLeft=Math.max(0,(Number(e.secondsLeft)||0)-1); delete e._plannedStep;
    if(e.secondsLeft<=0||Math.abs(Number(e.remaining)||0)<0.000001){
      e.secondsLeft=0;e.remaining=0;
      if(e.kind==="news"){
        const ev=(s.newsEvents||[]).find(x=>x.id===e.eventId);
        if(ev&&!ev.finished){ev.finished=true;ev.applied=round1(e.applied);ev.display=`${ev.text}ï¼${ev.applied>0?"+":""}${fmt(ev.applied)}åï¼`}
      }
    }
  }
  s.activeEffects=effects.filter(e=>Number(e.secondsLeft)>0&&Math.abs(Number(e.remaining)||0)>0.000001);
  s.price=round1(Math.max(minPrice,current+actualStep)); updateHourlyPriceRange(s,s.price,tickTime);
}
function tickStock(s,now,cfg,stockIndex){
  if(!Number.isFinite(Number(s.price)))s.price=INITIAL_PRICE;
  s.activeEffects=Array.isArray(s.activeEffects)?s.activeEffects:[]; s.newsEvents=Array.isArray(s.newsEvents)?s.newsEvents:[];
  let last=Number(s.lastTick); if(!Number.isFinite(last)||last>now||now-last>300000)last=now-1000;
  const elapsedMs=now-last; if(elapsedMs<900)return;
  const elapsed=Math.max(1,Math.min(10,Math.floor(elapsedMs/1000)));
  for(let step=0;step<elapsed;step++)processStock(s,last+1000*(step+1),cfg,stockIndex);
  s.lastTick=last+elapsed*1000;
}

function addHistoryUpdates(updates,stockIndex,st,now){
  for(const ev of (st.newsEvents||[])){
    if(!ev||ev.unaffected===true||ev.finished!==true||ev.historySaved===true)continue;
    const amount=round1(Number(ev.applied)||0); ev.historySaved=true;
    if(Math.abs(amount)<0.000001)continue;
    const createdAt=Number(ev.createdAt)||now,eventId=String(ev.id||`news-${createdAt}`),key=`${createdAt}_${firebaseKey(eventId)}`;
    updates[`newsHistory/${stockIndex}/${key}`]={id:eventId,stockIndex,text:String(ev.text||"ãã¥ã¼ã¹"),sourceCountry:String(ev.sourceCountry||""),sourceStockIndex:Number(ev.sourceStockIndex),time:createdAt,finishedAt:now,amount,direction:amount>0?"up":"down"};
  }
  const price=round1(Number(st.price)||INITIAL_PRICE),tenSecondBucket=Math.floor(now/10000),minuteBucket=Math.floor(now/60000);
  if(Number(st.lastPriceHistoryBucket)!==tenSecondBucket){
    st.lastPriceHistoryBucket=tenSecondBucket;
    const dayKey=jstDateKey(now),time=tenSecondBucket*10000;
    updates[`priceHistoryIntraday/${stockIndex}/${dayKey}/${time}`]={time,price};
    if(String(st.lastIntradayCleanupDay||"")!==dayKey){
      st.lastIntradayCleanupDay=dayKey;
      updates[`priceHistoryIntraday/${stockIndex}/${jstDateKey(now-9*86400000)}`]=null;
    }
  }
  if(Number(st.lastPriceHistoryMinute)!==minuteBucket){
    st.lastPriceHistoryMinute=minuteBucket;
    updates[`priceHistoryHourly/${stockIndex}/${jstHourStartMs(now)}`]={time:now,price};
    updates[`priceHistoryDaily/${stockIndex}/${jstDateKey(now)}`]={time:now,price};
  }
}

async function runEngineTick(){
  const now=Date.now();
  const [stocksRaw,stockSettings,queueRaw,controlRaw]=await Promise.all([
    fbGet("stocks"),fbGet("stockSettings"),fbGet("tradeQueue"),fbGet("meta/globalNewsControl")
  ]);
  const queue=queueRaw||{},control=controlRaw||{},stockList=[];
  const grouped=[[],[],[],[]];
  for(const [id,item] of Object.entries(queue)){
    const i=Number(item?.stockIndex); if(Number.isInteger(i)&&i>=0&&i<4)grouped[i].push({id,impact:Number(item.impact)||0});
  }
  for(let i=0;i<4;i++){
    let st=(stocksRaw?.[i]??stocksRaw?.[String(i)])||defaultStock(DEFAULT_STOCKS[i],now);
    if(!st.news||!Object.keys(st.news).length)st.news=structuredClone(DEFAULT_STOCKS[i].news);
    st.activeEffects=Array.isArray(st.activeEffects)?st.activeEffects.filter(e=>Number(e.secondsLeft)>0&&Math.abs(Number(e.remaining)||0)>0.000001):[];
    st.newsEvents=Array.isArray(st.newsEvents)?st.newsEvents:[];
    for(const e of st.activeEffects)if(e.kind==="news"&&!e.direction)e.direction=Number(e.totalEffect??e.remaining)<0?"down":"up";
    for(const item of grouped[i]){
      const impact=limitTrade(st,item.impact);
      if(impact!==0)st.activeEffects.push({kind:"trade",totalEffect:impact,remaining:impact,applied:0,secondsLeft:EFFECT_SECONDS});
    }
    stockList[i]=st;
  }
  let next=Number(control.nextNewsTime);
  if(!Number.isFinite(next)||next>now+60000||next<now-120000){next=now+globalNewsDelay();control.nextNewsTime=next}
  if(now>=next){
    const chosen=chooseGlobalNews(stockList,control);
    if(chosen){
      const result=applyGlobalNewsToStocks(stockList,chosen,stockSettings,now),dir=result?.direction||"",oldDir=String(control.lastDirection||""),oldCount=Number(control.directionStreak)||0;
      control.lastNewsToken=chosen.token; control.lastDirection=dir; control.directionStreak=dir&&dir===oldDir?oldCount+1:(dir?1:0);
      control.lastNewsAt=now; control.lastHeadline=String(chosen.news?.text||""); control.lastSourceStockIndex=Number(chosen.sourceStockIndex);
    }
    control.nextNewsTime=now+globalNewsDelay();
  }
  const updates={};
  for(let i=0;i<4;i++){
    const st=stockList[i],cfg=getStockSetting(i,st,stockSettings); tickStock(st,now,cfg,i); addHistoryUpdates(updates,i,st,now); updates[`stocks/${i}`]=st;
    for(const item of grouped[i])updates[`tradeQueue/${item.id}`]=null;
  }
  updates["meta/globalNewsControl"]=control;
  updates["meta/engine"]={id:ENGINE_ID,until:now+12000,server:true,lastTick:now};
  updates["meta/serverEngine"]={active:true,lastTick:now,intervalMs:ALARM_MS,provider:"cloudflare"};
  await fbPatch(updates);
  return {ok:true,at:now,prices:stockList.map(s=>s.price),nextNewsTime:control.nextNewsTime};
}

export class StockEngine extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env}
  async ensureAlarm(delay=250){
    const current=await this.ctx.storage.getAlarm();
    if(current==null)await this.ctx.storage.setAlarm(Date.now()+delay);
  }
  async fetch(request){
    const url=new URL(request.url);
    if(url.pathname==="/start"||url.pathname==="/"){
      await this.ensureAlarm(100);
      return Response.json({ok:true,message:"æ ªä¾¡ã¨ã³ã¸ã³ãéå§ãã¾ãã",nextAlarm:"scheduled"},{headers:{"cache-control":"no-store"}});
    }
    if(url.pathname==="/tick"){
      const result=await runEngineTick(); await this.ensureAlarm(ALARM_MS); return Response.json(result);
    }
    return Response.json({ok:true,service:"bunkasai-stock-engine"});
  }
  async alarm(){
    try{await runEngineTick()}catch(err){console.error("engine alarm",err?.stack||err)}
    finally{await this.ctx.storage.setAlarm(Date.now()+ALARM_MS)}
  }
}

export default {
  async fetch(request,env){
    const id=env.STOCK_ENGINE.idFromName("main");
    return env.STOCK_ENGINE.get(id).fetch(request);
  },
  async scheduled(controller,env,ctx){
    const id=env.STOCK_ENGINE.idFromName("main");
    const stub=env.STOCK_ENGINE.get(id);
    ctx.waitUntil(stub.fetch("https://engine.internal/start"));
  }
};
