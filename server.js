
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static("public"));

const rooms = new Map();

const ROLE_POOL = ["mafia", "oldman", "doctor"];

function makeCode() {
  let code;
  do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); }
  while (rooms.has(code));
  return code;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    phase: room.phase,
    players: [...room.players.values()].map(p => ({
      id: p.id, name: p.name, alive: p.alive,
      role: room.started ? undefined : null
    }))
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room:update", publicRoom(room));
}

function assignRoles(players) {
  const list = [...players];
  // Scales mafia count naturally while always keeping at least one civilian.
  const mafiaCount = list.length >= 8 ? 2 : 1;
  const roles = [];
  for (let i = 0; i < mafiaCount; i++) roles.push("mafia");
  if (list.length >= 4) roles.push("oldman");
  if (list.length >= 5) roles.push("doctor");
  while (roles.length < list.length) roles.push("citizen");
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  list.forEach((p, i) => p.role = roles[i]);
}

function checkWin(room) {
  const alive = [...room.players.values()].filter(p => p.alive);
  const mafia = alive.filter(p => p.role === "mafia").length;
  const nonMafia = alive.length - mafia;
  if (mafia === 0) return "citizens";
  if (mafia >= nonMafia) return "mafia";
  return null;
}

io.on("connection", socket => {
  socket.on("room:create", ({name}, cb) => {
    const code = makeCode();
    const room = {
      code, hostId: socket.id, started: false, phase: "lobby",
      players: new Map(), votes: new Map()
    };
    room.players.set(socket.id, {id: socket.id, name: String(name || "لاعب").slice(0,20), alive:true});
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    cb({ok:true, code});
    emitRoom(room);
  });

  socket.on("room:join", ({code, name}, cb) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) return cb({ok:false, error:"الغرفة غير موجودة"});
    if (room.started) return cb({ok:false, error:"اللعبة بدأت بالفعل"});
    if (room.players.size >= 16) return cb({ok:false, error:"الغرفة ممتلئة"});
    room.players.set(socket.id, {id:socket.id, name:String(name || "لاعب").slice(0,20), alive:true});
    socket.join(code);
    socket.data.roomCode = code;
    cb({ok:true, code});
    emitRoom(room);
  });

  socket.on("game:start", ({code}, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id) return cb?.({ok:false,error:"فقط الهوست يستطيع البدء"});
    if (room.players.size < 3) return cb?.({ok:false,error:"تحتاج 3 لاعبين على الأقل"});
    assignRoles(room.players.values());
    room.started = true;
    room.phase = "night";
    for (const p of room.players.values()) {
      io.to(p.id).emit("game:role", {
        role:p.role,
        roomCode:room.code,
        players:[...room.players.values()].map(x=>({id:x.id,name:x.name,alive:x.alive}))
      });
    }
    io.to(room.code).emit("game:notice", "بدأت اللعبة! راجع بطاقتك السرية.");
    emitRoom(room);
    cb?.({ok:true});
  });

  socket.on("game:phase", ({code, phase}, cb) => {
    const room = rooms.get(code);
    if (!room || room.hostId !== socket.id || !room.started) return cb?.({ok:false});
    if (!["night","day"].includes(phase)) return cb?.({ok:false});
    room.phase = phase;
    room.votes.clear();
    io.to(room.code).emit("game:phase", phase);
    emitRoom(room);
    cb?.({ok:true});
  });

  socket.on("game:vote", ({code,targetId}, cb) => {
    const room = rooms.get(code);
    const voter = room?.players.get(socket.id);
    const target = room?.players.get(targetId);
    if (!room || !voter || !target || !voter.alive || !target.alive)
      return cb?.({ok:false,error:"تصويت غير صالح"});
    if (room.phase !== "day") return cb?.({ok:false,error:"التصويت متاح في النهار فقط"});
    room.votes.set(socket.id,targetId);
    const alive = [...room.players.values()].filter(p=>p.alive);
    if ([...room.votes.keys()].length >= alive.length) {
      const counts = {};
      for (const t of room.votes.values()) counts[t]=(counts[t]||0)+1;
      const max = Math.max(...Object.values(counts));
      const winners = Object.entries(counts).filter(([,n])=>n===max).map(([id])=>id);
      if (winners.length===1) {
        const eliminated = room.players.get(winners[0]);
        eliminated.alive=false;
        io.to(room.code).emit("game:notice", `${eliminated.name} خرج من اللعبة.`);
      } else {
        io.to(room.code).emit("game:notice","تعادل! لم يخرج أحد.");
      }
      room.votes.clear();
      const win=checkWin(room);
      if(win){
        room.phase="ended";
        io.to(room.code).emit("game:ended", win);
      }
      emitRoom(room);
    }
    cb?.({ok:true});
  });

  socket.on("disconnect", () => {
    const code=socket.data.roomCode, room=rooms.get(code);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.hostId===socket.id) {
      const next=room.players.values().next().value;
      room.hostId=next?.id || null;
    }
    if (room.players.size===0) rooms.delete(code);
    else emitRoom(room);
  });
});

const PORT=process.env.PORT || 3000;
server.listen(PORT,()=>console.log(`Mafia server running on http://localhost:${PORT}`));
