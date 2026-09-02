const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 16;
const DEFAULTS = { night: 35, day: 75, vote: 30 };

function makeCode() {
  let code;
  do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(code));
  return code;
}

function assignRoles(players) {
  const list = [...players];
  const mafiaCount = list.length >= 8 ? 2 : 1;
  const roles = Array(mafiaCount).fill("mafia");
  if (list.length >= 4) roles.push("oldman");
  if (list.length >= 5) roles.push("doctor");
  while (roles.length < list.length) roles.push("citizen");
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  list.forEach((p, i) => { p.role = roles[i]; p.alive = true; p.usedOldman = false; });
}

function alivePlayers(room) { return [...room.players.values()].filter(p => p.alive); }
function checkWin(room) {
  const alive = alivePlayers(room);
  const mafia = alive.filter(p => p.role === "mafia").length;
  if (mafia === 0) return "citizens";
  if (mafia >= alive.length - mafia) return "mafia";
  return null;
}
function publicRoom(room) {
  return {
    code: room.code, hostId: room.hostId, started: room.started, phase: room.phase,
    maxPlayers: room.maxPlayers, timerEndsAt: room.timerEndsAt,
    players: [...room.players.values()].map(p => ({ id:p.id, name:p.name, alive:p.alive }))
  };
}
function emitRoom(room) { io.to(room.code).emit("room:update", publicRoom(room)); }
function privatePlayers(room, viewer) {
  return [...room.players.values()].map(p => ({ id:p.id, name:p.name, alive:p.alive, self:p.id===viewer.id }));
}
function clearTimer(room) { if (room.timer) clearTimeout(room.timer); room.timer = null; }
function startTimer(room, phase, seconds, done) {
  clearTimer(room);
  room.phase = phase;
  room.timerEndsAt = Date.now() + seconds * 1000;
  io.to(room.code).emit("game:phase", { phase, endsAt: room.timerEndsAt });
  emitRoom(room);
  room.timer = setTimeout(() => { room.timer = null; done(); }, seconds * 1000);
}
function finishGame(room, winner) {
  clearTimer(room); room.phase = "ended"; room.timerEndsAt = null;
  io.to(room.code).emit("game:ended", { winner, players:[...room.players.values()].map(p=>({name:p.name,role:p.role,alive:p.alive})) });
  emitRoom(room);
}
function resolveNight(room) {
  if (!room.started || room.phase !== "night") return;
  clearTimer(room);
  const victim = room.night.mafiaTarget ? room.players.get(room.night.mafiaTarget) : null;
  const saved = room.night.doctorTarget ? room.players.get(room.night.doctorTarget) : null;
  if (victim && victim.alive && victim.id !== saved?.id) {
    victim.alive = false;
    io.to(room.code).emit("game:notice", `☠️ ${victim.name} لم ينجُ من الليل.`);
  } else if (victim) {
    io.to(room.code).emit("game:notice", "🩺 الطبيب أنقذ الضحية! لا أحد مات الليلة.");
  } else {
    io.to(room.code).emit("game:notice", "🌙 مرّ الليل دون ضحية.");
  }
  for (const p of room.players.values()) {
    if (p.role === "oldman" && room.night.oldmanTarget) {
      const target = room.players.get(room.night.oldmanTarget);
      if (target) io.to(p.id).emit("oldman:result", { targetId:target.id, targetName:target.name, isMafia:target.role === "mafia" });
    }
  }
  room.night = { mafiaTarget:null, doctorTarget:null, oldmanTarget:null };
  const win = checkWin(room);
  if (win) return finishGame(room, win);
  startTimer(room, "day", room.settings.day, () => startVote(room));
}
function startVote(room) {
  if (!room.started) return;
  room.votes.clear();
  startTimer(room, "vote", room.settings.vote, () => resolveVote(room));
}
function resolveVote(room) {
  if (!room.started || room.phase !== "vote") return;
  clearTimer(room);
  const counts = {};
  for (const id of room.votes.values()) counts[id] = (counts[id] || 0) + 1;
  const max = Math.max(0, ...Object.values(counts));
  const winners = Object.entries(counts).filter(([,n]) => n === max).map(([id]) => id);
  if (winners.length === 1 && max > 0) {
    const eliminated = room.players.get(winners[0]);
    if (eliminated?.alive) { eliminated.alive = false; io.to(room.code).emit("game:eliminated", {name:eliminated.name, role:eliminated.role}); }
  } else io.to(room.code).emit("game:notice", "🗳️ تعادل! لم يخرج أحد.");
  room.votes.clear();
  const win = checkWin(room);
  if (win) return finishGame(room, win);
  startTimer(room, "night", room.settings.night, () => resolveNight(room));
}

io.on("connection", socket => {
  socket.on("room:create", ({name, maxPlayers, settings}, cb) => {
    const code = makeCode();
    const room = { code, hostId:socket.id, started:false, phase:"lobby", players:new Map(), votes:new Map(), night:{}, settings:{...DEFAULTS, ...(settings||{})}, maxPlayers:Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, Number(maxPlayers)||8)), timer:null, timerEndsAt:null };
    room.players.set(socket.id, {id:socket.id, name:String(name||"لاعب").slice(0,20), alive:true});
    rooms.set(code, room); socket.join(code); socket.data.roomCode=code;
    cb({ok:true,code}); emitRoom(room);
  });
  socket.on("room:join", ({code,name}, cb) => {
    const room = rooms.get(String(code||"").trim().toUpperCase());
    if (!room) return cb({ok:false,error:"الغرفة غير موجودة"});
    if (room.started) return cb({ok:false,error:"اللعبة بدأت بالفعل"});
    if (room.players.size >= room.maxPlayers) return cb({ok:false,error:"الغرفة ممتلئة"});
    room.players.set(socket.id,{id:socket.id,name:String(name||"لاعب").slice(0,20),alive:true});
    socket.join(room.code); socket.data.roomCode=room.code; cb({ok:true,code:room.code}); emitRoom(room);
  });
  socket.on("game:start", ({code}, cb) => {
    const room=rooms.get(code); if(!room||room.hostId!==socket.id) return cb?.({ok:false,error:"فقط الهوست يستطيع البدء"});
    if(room.players.size<MIN_PLAYERS) return cb?.({ok:false,error:`تحتاج ${MIN_PLAYERS} لاعبين على الأقل`});
    assignRoles(room.players.values()); room.started=true;
    for(const p of room.players.values()) io.to(p.id).emit("game:role",{role:p.role,players:privatePlayers(room,p),roomCode:room.code});
    io.to(room.code).emit("game:notice","🎴 تم توزيع الأدوار! استعدوا للليل.");
    startTimer(room,"night",room.settings.night,()=>resolveNight(room));
  });
  socket.on("night:action", ({code,action,targetId},cb) => {
    const room=rooms.get(code), p=room?.players.get(socket.id), target=room?.players.get(targetId);
    if(!room||!p||!p.alive||room.phase!=="night"||!target||!target.alive) return cb?.({ok:false,error:"حركة غير صالحة"});
    if(action==="kill" && p.role!=="mafia") return cb?.({ok:false,error:"لست مافيا"});
    if(action==="save" && p.role!=="doctor") return cb?.({ok:false,error:"لست الطبيب"});
    if(action==="check" && p.role!=="oldman") return cb?.({ok:false,error:"لست الشايب"});
    if(action==="check" && p.usedOldman) return cb?.({ok:false,error:"قدرة الشايب استُخدمت"});
    if(target.id===p.id && action!=="save") return cb?.({ok:false,error:"لا يمكنك اختيار نفسك"});
    if(action==="kill") room.night.mafiaTarget=target.id;
    if(action==="save") room.night.doctorTarget=target.id;
    if(action==="check"){room.night.oldmanTarget=target.id;p.usedOldman=true;}
    cb?.({ok:true});
    const mafiaDone=[...room.players.values()].filter(x=>x.alive&&x.role==="mafia").every(x=>room.night.mafiaTarget);
    const doctor=[...room.players.values()].find(x=>x.alive&&x.role==="doctor");
    const oldman=[...room.players.values()].find(x=>x.alive&&x.role==="oldman"&&!x.usedOldman);
    if(mafiaDone && (!doctor||room.night.doctorTarget) && (!oldman||room.night.oldmanTarget||oldman.usedOldman)) resolveNight(room);
  });
  socket.on("chat:send", ({code,text},cb) => {
    const room=rooms.get(code), p=room?.players.get(socket.id); text=String(text||"").trim().slice(0,300);
    if(!room||!p||!p.alive||room.phase!=="day"||!text) return cb?.({ok:false});
    io.to(room.code).emit("chat:message",{id:p.id,name:p.name,text,at:Date.now()}); cb?.({ok:true});
  });
  socket.on("game:vote", ({code,targetId},cb) => {
    const room=rooms.get(code), voter=room?.players.get(socket.id), target=room?.players.get(targetId);
    if(!room||room.phase!=="vote"||!voter?.alive||!target?.alive||voter.id===target.id) return cb?.({ok:false,error:"تصويت غير صالح"});
    room.votes.set(socket.id,target.id); io.to(room.code).emit("vote:update",{count:room.votes.size,total:alivePlayers(room).length});
    if(room.votes.size>=alivePlayers(room).length) resolveVote(room); cb?.({ok:true});
  });
  socket.on("host:kick", ({code,targetId},cb) => {
    const room=rooms.get(code); if(!room||room.hostId!==socket.id||targetId===socket.id) return cb?.({ok:false});
    const target=room.players.get(targetId); if(!target) return cb?.({ok:false});
    io.to(targetId).emit("room:kicked"); io.sockets.sockets.get(targetId)?.disconnect(true); room.players.delete(targetId); emitRoom(room); cb?.({ok:true});
  });
  socket.on("room:leave", ({code}) => socket.disconnect(true));
  socket.on("game:rematch", ({code},cb) => {
    const room=rooms.get(code); if(!room||room.hostId!==socket.id||room.phase!=="ended") return cb?.({ok:false});
    room.started=false; room.phase="lobby"; room.votes.clear(); room.night={}; room.timerEndsAt=null; room.players.forEach(p=>{p.alive=true;p.role=null;p.usedOldman=false;}); emitRoom(room); cb?.({ok:true});
  });
  socket.on("voice:signal", ({code,to,data}) => { const room=rooms.get(code); if(room?.players.has(socket.id)&&room.players.has(to)) io.to(to).emit("voice:signal",{from:socket.id,data}); });
  socket.on("disconnect",()=>{ const code=socket.data.roomCode,room=rooms.get(code); if(!room)return; room.players.delete(socket.id); if(room.hostId===socket.id) room.hostId=room.players.values().next().value?.id||null; if(room.players.size===0){clearTimer(room);rooms.delete(code);} else emitRoom(room); });
});

const PORT=process.env.PORT||3000; server.listen(PORT,()=>console.log(`Mafia server running on http://localhost:${PORT}`));
