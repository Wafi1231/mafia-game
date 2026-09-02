
const socket=io();
let me={name:"",code:"",host:false,role:null};
const $=id=>document.getElementById(id);
const show=(id,on=true)=>$(id).classList.toggle("hidden",!on);
function err(x){$("error").textContent=x||""}
function roleInfo(role){
 const m={mafia:["المافيا","أنت من المافيا. اعملوا سراً على إخراج المواطنين.","☠️"],
 oldman:["الشايب","أنت الشايب. دورك خاص، وحاول مساعدة فريق المواطنين دون كشف نفسك.","🧓"],
 doctor:["الطبيب","أنت الطبيب. هدفك مساعدة المواطنين وحماية الفريق.","🩺"],
 citizen:["مواطن","أنت مواطن. اكتشف المافيا بالتحليل والتصويت.","👤"]};
 return m[role]||["غير معروف","", "?"];
}
function enterLobby(){
 show("home",false);show("lobby",true);show("game",false);
 $("roomCode").textContent=me.code;
}
$("create").onclick=()=>{
 me.name=$("name").value.trim()||"لاعب";
 socket.emit("room:create",{name:me.name},r=>{if(!r.ok)return err(r.error);me.code=r.code;me.host=true;enterLobby();});
};
$("join").onclick=()=>{
 me.name=$("name").value.trim()||"لاعب";
 const code=$("code").value.trim().toUpperCase();
 socket.emit("room:join",{name:me.name,code},r=>{if(!r.ok)return err(r.error);me.code=r.code;enterLobby();});
};
$("copy").onclick=()=>navigator.clipboard?.writeText(me.code);
socket.on("room:update",room=>{
 me.host=room.hostId===socket.id;
 if(!room.started){
  show("home",false);show("lobby",true);show("game",false);
  $("roomCode").textContent=room.code;$("count").textContent=`(${room.players.length}/16)`;
  $("players").innerHTML=room.players.map(p=>`<div class="player"><span>${escapeHtml(p.name)}</span>${p.id===room.hostId?'<span class="badge">HOST</span>':''}</div>`).join("");
  $("hostControls").innerHTML=me.host?`<div class="host"><button id="start">ابدأ اللعبة</button></div>`:"";
  if(me.host)$("start").onclick=()=>socket.emit("game:start",{code:me.code},r=>{if(r&&!r.ok)err(r.error)});
 }else renderPlayers(room.players,room.phase);
});
socket.on("game:role",d=>{
 me.role=d.role;show("home",false);show("lobby",false);show("game",true);
 const [name,desc,icon]=roleInfo(d.role);$("roleName").textContent=name;$("roleDesc").textContent=desc;$("roleCard").querySelector(".roleIcon").textContent=icon;
});
socket.on("game:phase",p=>{ $("phaseText").textContent=p==="night"?"الليل":"النهار"; renderPhaseControls(p); });
socket.on("game:notice",x=>$("notice").textContent=x);
socket.on("game:ended",winner=>{
 $("gameControls").innerHTML=`<div class="end">${winner==="mafia"?"☠️ المافيا فازت!":"🎉 المواطنون فازوا!"}</div>`;
});
function renderPlayers(players,phase){
 $("gamePlayers").innerHTML=players.map(p=>{
  const disabled=!p.alive||p.id===socket.id||phase!=="day";
  return `<div class="player ${p.alive?"":"dead"}"><span>${escapeHtml(p.name)}</span><button class="vote" ${disabled?"disabled":""} data-id="${p.id}">تصويت</button></div>`;
 }).join("");
 document.querySelectorAll(".vote").forEach(b=>b.onclick=()=>socket.emit("game:vote",{code:me.code,targetId:b.dataset.id}));
}
function renderPhaseControls(phase){
 if(!me.host)return $("gameControls").innerHTML="";
 $("gameControls").innerHTML=phase==="night"?`<button class="secondary" id="day">بدء النهار والتصويت</button>`:`<button class="secondary" id="night">بدء الليل</button>`;
 $(phase==="night"?"day":"night").onclick=()=>socket.emit("game:phase",{code:me.code,phase:phase==="night"?"day":"night"});
}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
