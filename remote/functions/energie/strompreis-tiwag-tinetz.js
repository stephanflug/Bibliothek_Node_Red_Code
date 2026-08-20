"use strict";

module.exports = async function run(ctx) {
  const { msg, node, flow, global, config, httpRequest, RED } = ctx;
  const num=(v,d)=>Number.isFinite(Number(v))?Number(v):d;
  const bool=(v,d)=>typeof v==="boolean"?v:(v==="true"||v===1||v==="1"?true:(v==="false"||v===0||v==="0"?false:d));
  const rnd=(v,d=3)=>Math.round((Number(v)+Number.EPSILON)*10**d)/10**d;
  const ct=s=>Number(String(s).replace(",","."));
  const norm=s=>String(s||"").normalize("NFKC").replace(/[\u00A0\u202F\u2007]/g," ").replace(/[\u200B\u00AD]/g,"").replace(/\s+/g," ").trim();
  const text=h=>norm(String(h||"").replace(/<script\b[\s\S]*?<\/script>/gi," ").replace(/<style\b[\s\S]*?<\/style>/gi," ").replace(/<!--[\s\S]*?-->/g," ").replace(/<[^>]+>/g," ").replace(/&nbsp;|&#160;/gi," ").replace(/&amp;/gi,"&"));
  const title=h=>{const m=String(h||"").match(/<title[^>]*>([\s\S]*?)<\/title>/i);return m?text(m[1]):null};
  const isCookie=(t,ti)=>`${ti||""} ${t||""}`.toLowerCase().includes("cookie-information")||`${ti||""} ${t||""}`.toLowerCase().includes("cookie-popup does not work properly without javascript");
  const rx=(s,n,f="i")=>{try{return new RegExp(String(s||""),f)}catch(e){throw new Error(`${n}: ungültiger RegEx: ${e.message}`)}};
  const valid=v=>Number.isFinite(v)&&v>0&&v<=100;

  const C={
    energyUrl:String(config.energyUrl||"https://www.tiwag.at/tutwas/").trim(),
    gridUrl:String(config.gridUrl||"https://www.tinetz.at/infobereich/allgemeines/netztarifaenderungen-ab-2026/").trim(),
    feedInEnabled:bool(config.feedInEnabled,true),
    feedInUrl:String(config.feedInUrl||"https://www.tiwag.at/privat/photovoltaik/tiwag-pv-einspeisung/").trim(),
    energyFallbackCt:num(config.energyFallbackCt,11.76),gridFallbackCt:num(config.gridFallbackCt,8.66),feedInFallbackCt:num(config.feedInFallbackCt,8.29),
    extraCt:num(config.extraCtPerKwh,0),vat:num(config.vatPercent,20),allowFallback:bool(config.allowFallback,true),
    timeout:Math.max(3,Math.min(120,num(config.timeoutSec,15)))*1000,
    energyGrossRegex:String(config.energyGrossRegex||"(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*inkl\\.?\\s*USt"),
    energyNetRegex:String(config.energyNetRegex||"(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh\\s*exkl\\.?\\s*USt"),
    gridRegex:String(config.gridRegex||"Tirol[^.]{0,160}?(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
    feedInRegex:String(config.feedInRegex||"Q([1-4])\\s*(\\d{4})[^\\d]{0,120}?(\\d{1,2}[,.]\\d{1,3})\\s*(?:Cent|ct)\\s*\\/?\\s*kWh"),
    topicEur:String(config.topicEur||"0_userdata.0.PV.Ersparnis.Strompreis_EUR_kWh"),
    topicCt:String(config.topicCt||"0_userdata.0.PV.Ersparnis.Strompreis_ct_kWh"),
    topicFeed:String(config.topicFeedInCt||"0_userdata.0.PV.Einspeisung.Strompreis_ct_kWh")
  };

  function coreRequest(url) {
    return new Promise((resolve,reject)=>{
      try {
        const T=RED&&RED.nodes&&RED.nodes.getType&&RED.nodes.getType("http request");
        if(typeof T!=="function") throw new Error("Core-Node 'http request' nicht verfügbar");
        const id=RED.util&&RED.util.generateId?RED.util.generateId():`ebst-${Date.now()}-${Math.random()}`;
        const h=new T({id,type:"http request",z:node.z,g:node.g,_flow:node._flow,name:"EBST intern",method:"GET",ret:"txt",paytoqs:"ignore",url:"",tls:"",persist:false,proxy:"",insecureHTTPParser:false,authType:"",senderr:false,headers:[],wires:[[]]});
        const fn=h._inputCallback||(h._inputCallbacks&&h._inputCallbacks[0]);
        if(typeof fn!=="function") throw new Error("Core HTTP Input-Handler fehlt");
        let done=false;
        const timer=setTimeout(()=>{if(!done){done=true;try{h.close&&h.close(false)}catch(_){}reject(new Error("Core HTTP Timeout"))}},C.timeout+5000);
        const finish=(e,o)=>{if(done)return;done=true;clearTimeout(timer);try{h.close&&h.close(false)}catch(_){}
          if(e)return reject(e instanceof Error?e:new Error(String(e)));
          if(!o)return reject(new Error("Core HTTP lieferte keine Nachricht"));
          resolve({statusCode:+o.statusCode||0,headers:o.headers||{},url:o.responseUrl||url,body:o.payload,redirectList:o.redirectList||[]});
        };
        fn.call(h,{url,method:"GET",requestTimeout:C.timeout,followRedirects:true},o=>finish(null,Array.isArray(o)?o.flat(Infinity).find(Boolean):o),e=>{if(e)finish(e)});
      } catch(e){reject(e)}
    });
  }

  async function get(url) {
    let coreErr=null,r,method="node-red-core-http-request";
    try { r=await coreRequest(url); }
    catch(e) {
      coreErr=e.message;
      if(typeof httpRequest!=="function") throw e;
      method="ebst-http-got-fallback";
      r=await httpRequest({method:"GET",url,responseType:"text",timeoutMs:C.timeout,maxRedirects:21,followRedirects:true,decompress:false,maxBodyBytes:6*1024*1024});
    }
    const html=String(r.body??r.payload??""), t=text(html), ti=title(html);
    const page={httpStatus:+r.statusCode||0,finalUrl:r.url||url,contentType:String((r.headers&&r.headers["content-type"])||""),fetchMethod:method,bytes:Buffer.byteLength(html),title:ti,preview:t.slice(0,260),cookieWallDetected:isCookie(t,ti),redirects:Array.isArray(r.redirectList)?r.redirectList.length:0,coreError:coreErr};
    if(page.httpStatus<200||page.httpStatus>=300){const e=new Error(`HTTP ${page.httpStatus}`);e.page=page;throw e}
    return {t,page};
  }

  function energy(t) {
    const gross=[[rx(C.energyGrossRegex,"TIWAG Brutto"),"Webseite brutto · RegEx"],[/(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh\s*inkl\.?\s*USt/i,"Webseite brutto · Standard"]];
    for(const [r,s] of gross){const m=r.exec(t),v=m?ct(m[1]):NaN;if(valid(v))return{ct:rnd(v),source:s,matched:m[0],fallback:false}}
    const nets=[[rx(C.energyNetRegex,"TIWAG Netto"),"Webseite netto · RegEx"],[/(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh\s*exkl\.?\s*USt/i,"Webseite netto · Standard"]];
    for(const [r,s] of nets){const m=r.exec(t),v=m?ct(m[1]):NaN;if(valid(v))return{ct:rnd(v*(1+C.vat/100)),netCt:rnd(v),source:`${s} + ${C.vat}% USt`,matched:m[0],fallback:false}}
    return null;
  }

  function grid(t) {
    const ps=[[rx(C.gridRegex,"TINETZ"),"Webseite · RegEx"],[/Tirol[^.]{0,180}?(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh/i,"Webseite · Tirol"],[/Netzentgelt\w*[^.]{0,240}?(\d{1,2}[,.]\d{1,3})\s*Cent\s*\/?\s*kWh/i,"Webseite · Netzentgelt"]];
    for(const [r,s] of ps){const m=r.exec(t),v=m?ct(m[1]):NaN;if(valid(v))return{ct:rnd(v),source:s,matched:m[0],fallback:false}}
    return null;
  }

  function feed(t) {
    const rows=[],ps=[rx(C.feedInRegex,"PV Einspeisung","gi"),/Q\s*([1-4])\s*[\/-]?\s*(\d{4})[^\d]{0,180}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi,/([1-4])\.\s*Quartal\s*(\d{4})[^\d]{0,180}?(\d{1,2}[,.]\d{1,3})\s*(?:Cent|ct)\s*\/?\s*kWh/gi];
    for(const r of ps){let m;while((m=r.exec(t))){const q=+m[1],y=+m[2],v=ct(m[3]);if(q>=1&&q<=4&&y>=2000&&y<=2200&&valid(v)&&!rows.some(x=>x.q===q&&x.y===y))rows.push({q,y,ct:rnd(v),matched:m[0]});if(!m[0])r.lastIndex++}}
    if(!rows.length)return null;
    const now=new Date(),q=Math.floor(now.getMonth()/3)+1,y=now.getFullYear(),key=y*4+q;
    let s=rows.find(x=>x.q===q&&x.y===y),source="Webseite aktuelles Quartal";
    if(!s){s=rows.filter(x=>x.y*4+x.q<=key).sort((a,b)=>(b.y*4+b.q)-(a.y*4+a.q))[0]||rows.sort((a,b)=>(b.y*4+b.q)-(a.y*4+a.q))[0];source="Webseite neuester Quartalspreis"}
    return{enabled:true,ct:s.ct,eur:rnd(s.ct/100,5),quarter:s.q,year:s.y,source,matched:s.matched,foundPrices:rows.length,fallback:false};
  }

  async function loadPrice(kind,url,fallback) {
    let page=null,err=null;
    try {
      const x=await get(url);page=x.page;
      const f=kind==="energy"?energy(x.t):kind==="grid"?grid(x.t):feed(x.t);
      if(f)return{...f,page};
      err=page.cookieWallDetected?"Cookie-Seite statt Tarifseite erhalten":"Preis nicht gefunden";
    } catch(e){page=e.page||null;err=e.message}
    if(!C.allowFallback)throw new Error(`${kind}: ${err}`);
    if(kind==="feed")return{enabled:true,ct:rnd(fallback),eur:rnd(fallback/100,5),quarter:null,year:null,source:"Fallback",fallback:true,matched:null,foundPrices:0,error:err,page};
    return{ct:rnd(fallback),netCt:null,source:"Fallback",fallback:true,matched:null,error:err,page};
  }

  node.status({fill:"blue",shape:"ring",text:"Strompreise werden geladen"});
  const pFeed=C.feedInEnabled?loadPrice("feed",C.feedInUrl,C.feedInFallbackCt):Promise.resolve({enabled:false,ct:null,eur:null,quarter:null,year:null,source:"deaktiviert",fallback:false,matched:null,foundPrices:0,error:null,page:null});
  const [e,g,p]=await Promise.all([loadPrice("energy",C.energyUrl,C.energyFallbackCt),loadPrice("grid",C.gridUrl,C.gridFallbackCt),pFeed]);

  const energyCt=rnd(e.ct),gridCt=rnd(g.ct),totalCt=rnd(energyCt+gridCt+C.extraCt),eur=rnd(totalCt/100,5);
  const feedInCt=p.enabled&&valid(p.ct)?rnd(p.ct):null,feedInEur=feedInCt==null?null:rnd(feedInCt/100,5);
  const selfUseAdvantageCt=feedInCt==null?null:rnd(totalCt-feedInCt),selfUseAdvantageEur=selfUseAdvantageCt==null?null:rnd(selfUseAdvantageCt/100,5);
  const updated=new Date().toISOString(),fallbackActive=!!(e.fallback||g.fallback||(p.enabled&&p.fallback));

  const vals={tiwag_energy_ct_kwh_gross:energyCt,tinetz_net_ct_kwh:gridCt,strompreis_ct_kwh:totalCt,strompreis_eur_kwh:eur,strompreis_last_update:updated,pv_einspeisung_ct_kwh:feedInCt,pv_einspeisung_eur_kwh:feedInEur,pv_eigenverbrauch_mehrwert_ct_kwh:selfUseAdvantageCt,pv_eigenverbrauch_mehrwert_eur_kwh:selfUseAdvantageEur};
  for(const [k,v] of Object.entries(vals))flow.set(k,v);
  global.set("strompreis_tiwag_energy_ct_kwh_gross",energyCt);global.set("strompreis_tinetz_net_ct_kwh",gridCt);
  for(const k of ["strompreis_ct_kwh","strompreis_eur_kwh","strompreis_last_update","pv_einspeisung_ct_kwh","pv_einspeisung_eur_kwh","pv_eigenverbrauch_mehrwert_ct_kwh","pv_eigenverbrauch_mehrwert_eur_kwh"])global.set(k,vals[k]);

  const details={energyCt,gridCt,extraCt:rnd(C.extraCt),totalCt,eur,feedInCt,feedInEur,selfUseAdvantageCt,selfUseAdvantageEur,updated,fallbackActive,inputMode:"node-red-core-http-request",
    energy:{url:C.energyUrl,valueCt:energyCt,source:e.source,fallback:e.fallback,netCt:e.netCt??null,matched:e.matched||null,error:e.error||null,page:e.page||null},
    grid:{url:C.gridUrl,valueCt:gridCt,source:g.source,fallback:g.fallback,matched:g.matched||null,error:g.error||null,page:g.page||null},
    feedIn:{enabled:p.enabled,url:C.feedInUrl,valueCt:feedInCt,valueEur:feedInEur,quarter:p.quarter,year:p.year,source:p.source,fallback:p.fallback,matched:p.matched||null,foundPrices:p.foundPrices||0,error:p.error||null,page:p.page||null}};

  node.status({fill:fallbackActive?"yellow":"green",shape:fallbackActive?"ring":"dot",text:`${totalCt} ct/kWh · PV ${feedInCt!==null?feedInCt+" ct":"aus"}${fallbackActive?" · Fallback":""}`});
  return [{...msg,payload:eur,topic:C.topicEur},{...msg,payload:totalCt,topic:C.topicCt},p.enabled?{...msg,payload:feedInCt,topic:C.topicFeed}:null,{topic:"strompreis-details",payload:details}];
};
