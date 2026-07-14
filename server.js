
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true }));

const rooms = new Map();
const GAME_TYPES = ["Техасский холдем", "Омаха", "Шестикарточный покер", "Sit & Go"];

function createDeck() {
  const suits = ["♠","♥","♦","♣"];
  const ranks = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({r,s});
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function rankValue(r){ return {"2":2,"3":3,"4":4,"5":5,"6":6,"7":7,"8":8,"9":9,"10":10,"J":11,"Q":12,"K":13,"A":14}[r]; }

function combinations(arr, k) {
  const out = [];
  function rec(start, pick) {
    if (pick.length === k) return out.push(pick.slice());
    for (let i=start;i<arr.length;i++){ pick.push(arr[i]); rec(i+1,pick); pick.pop(); }
  }
  rec(0,[]);
  return out;
}

function evaluate5(cards) {
  let values = cards.map(c=>rankValue(c.r)).sort((a,b)=>b-a);
  const suits = cards.map(c=>c.s);
  const counts = {};
  values.forEach(v=>counts[v]=(counts[v]||0)+1);
  const groups = Object.entries(counts).map(([v,c])=>({v:+v,c})).sort((a,b)=>b.c-a.c||b.v-a.v);
  const flush = new Set(suits).size===1;
  let uniq=[...new Set(values)];
  if(uniq.includes(14)) uniq.push(1);
  let straightHigh=0;
  for(let i=0;i<=uniq.length-5;i++){
    if(uniq[i]-uniq[i+4]===4){straightHigh=uniq[i];break;}
  }
  if(flush&&straightHigh) return {score:[8,straightHigh],name:"Стрит-флеш"};
  if(groups[0].c===4) return {score:[7,groups[0].v,groups[1].v],name:"Каре"};
  if(groups[0].c===3&&groups[1].c===2) return {score:[6,groups[0].v,groups[1].v],name:"Фулл-хаус"};
  if(flush) return {score:[5,...values],name:"Флеш"};
  if(straightHigh) return {score:[4,straightHigh],name:"Стрит"};
  if(groups[0].c===3) return {score:[3,groups[0].v,...groups.slice(1).map(g=>g.v).sort((a,b)=>b-a)],name:"Тройка"};
  if(groups[0].c===2&&groups[1].c===2){
    const pairs=[groups[0].v,groups[1].v].sort((a,b)=>b-a);
    const kicker=groups.find(g=>g.c===1).v;
    return {score:[2,...pairs,kicker],name:"Две пары"};
  }
  if(groups[0].c===2) return {score:[1,groups[0].v,...groups.slice(1).map(g=>g.v).sort((a,b)=>b-a)],name:"Пара"};
  return {score:[0,...values],name:"Старшая карта"};
}

function compareScore(a,b){
  const n=Math.max(a.length,b.length);
  for(let i=0;i<n;i++){const av=a[i]||0,bv=b[i]||0;if(av!==bv)return av-bv;}
  return 0;
}

function bestHand(cards){
  let best=null;
  for(const hand of combinations(cards,5)){
    const e=evaluate5(hand);
    if(!best||compareScore(e.score,best.score)>0) best={...e,cards:hand};
  }
  return best;
}

function activePlayers(room){ return [...room.players.values()].filter(p=>p.inHand&&!p.folded); }
function seatedPlayers(room){ return [...room.players.values()].sort((a,b)=>a.seat-b.seat); }

function nextActiveIndex(room, fromIdx) {
  const ps=seatedPlayers(room);
  if(!ps.length) return -1;
  for(let step=1;step<=ps.length;step++){
    const idx=(fromIdx+step)%ps.length, p=ps[idx];
    if(p.inHand&&!p.folded&&!p.allIn) return idx;
  }
  return -1;
}

function roomState(room) {
  return {
    id: room.id, game: room.game, maxPlayers: room.maxPlayers,
    players: seatedPlayers(room).map(p=>({
      id:p.id,name:p.name,balance:p.balance,seat:p.seat,ready:p.ready,
      folded:p.folded,inHand:p.inHand,bet:p.bet,allIn:p.allIn
    })),
    dealerMessage: room.dealerMessage, community: room.community, pot: room.pot,
    started: room.started, phase: room.phase, currentBet: room.currentBet,
    currentPlayerId: room.currentPlayerId, dealerSeat: room.dealerSeat,
    smallBlind: room.smallBlind, bigBlind: room.bigBlind
  };
}

function broadcastRoom(room){ io.to(room.id).emit("room_state",roomState(room)); }

function collectBets(room){
  for(const p of room.players.values()){ room.pot+=p.bet; p.bet=0; }
  room.currentBet=0;
}

function postBet(room,p,amount){
  const pay=Math.min(amount,p.balance);
  p.balance-=pay;p.bet+=pay;
  if(p.balance===0)p.allIn=true;
  return pay;
}

function startBettingRound(room, phase){
  room.phase=phase;
  room.acted=new Set();
  room.currentBet=0;
  for(const p of room.players.values()) p.bet=0;
  const ps=seatedPlayers(room);
  const dealerIdx=ps.findIndex(p=>p.seat===room.dealerSeat);
  const next=nextActiveIndex(room,dealerIdx);
  room.currentPlayerId=next>=0?ps[next].id:null;
}

function revealPhase(room){
  collectBets(room);
  if(activePlayers(room).length<=1) return finishByFold(room);
  if(room.phase==="preflop"){
    room.community=[room.deck.pop(),room.deck.pop(),room.deck.pop()];
    room.dealerMessage="Дилер открыл флоп";
    startBettingRound(room,"flop");
  }else if(room.phase==="flop"){
    room.community.push(room.deck.pop());
    room.dealerMessage="Дилер открыл тёрн";
    startBettingRound(room,"turn");
  }else if(room.phase==="turn"){
    room.community.push(room.deck.pop());
    room.dealerMessage="Дилер открыл ривер";
    startBettingRound(room,"river");
  }else{
    collectBets(room);
    showdown(room);
  }
}

function bettingRoundComplete(room){
  const act=activePlayers(room).filter(p=>!p.allIn);
  if(act.length===0) return true;
  return act.every(p=>room.acted.has(p.id)&&p.bet===room.currentBet);
}

function advanceTurn(room){
  if(activePlayers(room).length<=1) return finishByFold(room);
  if(bettingRoundComplete(room)) return revealPhase(room);
  const ps=seatedPlayers(room);
  const cur=ps.findIndex(p=>p.id===room.currentPlayerId);
  const n=nextActiveIndex(room,cur);
  room.currentPlayerId=n>=0?ps[n].id:null;
  if(!room.currentPlayerId) revealPhase(room);
}

function finishByFold(room){
  collectBets(room);
  const winner=activePlayers(room)[0];
  if(!winner)return;
  winner.balance+=room.pot;
  room.dealerMessage=`${winner.name} выигрывает банк ${room.pot} сом`;
  io.to(room.id).emit("round_winner",{playerId:winner.id,name:winner.name,amount:room.pot,hand:"Все соперники сбросили карты"});
  resetAfterHand(room);
}

function showdown(room){
  const contenders=activePlayers(room);
  let best=null,winners=[];
  for(const p of contenders){
    const hand=bestHand([...p.cards,...room.community]);
    p.handResult=hand;
    if(!best||compareScore(hand.score,best.score)>0){best=hand;winners=[p];}
    else if(compareScore(hand.score,best.score)===0)winners.push(p);
  }
  const share=Math.floor(room.pot/winners.length);
  winners.forEach(w=>w.balance+=share);
  const names=winners.map(w=>w.name).join(", ");
  room.dealerMessage=`${names} выигрывает ${room.pot} сом — ${best.name}`;
  io.to(room.id).emit("showdown",{
    players:contenders.map(p=>({id:p.id,name:p.name,cards:p.cards,hand:p.handResult.name})),
    winners:winners.map(w=>w.id), amount:room.pot, hand:best.name, names
  });
  io.to(room.id).emit("round_winner",{playerId:winners[0].id,name:names,amount:room.pot,hand:best.name});
  resetAfterHand(room);
}

function resetAfterHand(room){
  room.pot=0;room.started=false;room.phase="waiting";room.currentBet=0;room.currentPlayerId=null;
  for(const p of room.players.values()){
    p.ready=false;p.inHand=false;p.folded=false;p.allIn=false;p.bet=0;p.cards=[];p.handResult=null;
  }
  setTimeout(()=>broadcastRoom(room),100);
}

function beginHand(room){
  const ps=seatedPlayers(room).filter(p=>p.ready&&p.balance>=room.bigBlind);
  if(ps.length<2) throw new Error("Для начала нужны минимум 2 готовых игрока");
  room.started=true;room.phase="preflop";room.community=[];room.pot=0;room.deck=createDeck();room.acted=new Set();
  const all=seatedPlayers(room);
  const currentDealerIdx=all.findIndex(p=>p.seat===room.dealerSeat);
  let nextDealer=nextActiveIndex({...room,players:new Map(all.filter(p=>p.ready).map(p=>[p.id,p]))},Math.max(-1,currentDealerIdx));
  const readySorted=all.filter(p=>p.ready);
  room.dealerSeat=readySorted[(readySorted.findIndex(p=>p.seat===room.dealerSeat)+1+readySorted.length)%readySorted.length]?.seat ?? readySorted[0].seat;
  for(const p of room.players.values()){
    p.inHand=p.ready&&p.balance>=room.bigBlind;p.folded=false;p.allIn=false;p.bet=0;p.cards=[];
    if(p.inHand){p.cards=[room.deck.pop(),room.deck.pop()];io.to(p.id).emit("private_cards",p.cards);}
  }
  const active=seatedPlayers(room).filter(p=>p.inHand);
  const dIdx=active.findIndex(p=>p.seat===room.dealerSeat);
  const sb=active[(dIdx+1)%active.length],bb=active[(dIdx+2)%active.length];
  postBet(room,sb,room.smallBlind);postBet(room,bb,room.bigBlind);
  room.currentBet=room.bigBlind;
  room.dealerMessage=`Блайнды ${room.smallBlind}/${room.bigBlind}. Ход после большого блайнда`;
  const first=active[(dIdx+3)%active.length];
  room.currentPlayerId=first.id;
  broadcastRoom(room);
}

io.on("connection", socket=>{
  socket.on("list_rooms",()=>socket.emit("rooms_list",[...rooms.values()].map(r=>({id:r.id,game:r.game,players:r.players.size,maxPlayers:r.maxPlayers,started:r.started}))));

  socket.on("create_room",({game,maxPlayers=6})=>{
    const id=Math.random().toString(36).slice(2,8).toUpperCase();
    rooms.set(id,{id,game:GAME_TYPES.includes(game)?game:GAME_TYPES[0],maxPlayers:Math.max(2,Math.min(8,+maxPlayers||6)),
      players:new Map(),dealerMessage:"Дилер ждёт игроков",community:[],pot:0,started:false,phase:"waiting",
      deck:[],dealerSeat:-1,currentPlayerId:null,currentBet:0,acted:new Set(),smallBlind:25,bigBlind:50});
    socket.emit("room_created",{roomId:id});
  });

  socket.on("join_room",({roomId,name})=>{
    const room=rooms.get(String(roomId||"").toUpperCase());
    if(!room)return socket.emit("error_message","Комната не найдена");
    if(room.started)return socket.emit("error_message","Дождитесь окончания текущей раздачи");
    if(room.players.size>=room.maxPlayers)return socket.emit("error_message","Нет свободных мест");
    const clean=String(name||"Игрок").trim().slice(0,20);
    if([...room.players.values()].some(p=>p.name.toLowerCase()===clean.toLowerCase()))return socket.emit("error_message","Имя уже занято");
    const used=new Set([...room.players.values()].map(p=>p.seat));let seat=0;while(used.has(seat))seat++;
    room.players.set(socket.id,{id:socket.id,name:clean,balance:10000,seat,ready:false,cards:[],bet:0,folded:false,inHand:false,allIn:false});
    socket.join(room.id);socket.data.roomId=room.id;socket.data.playerName=clean;
    io.to(room.id).emit("system_message",`${clean} присоединился к столу`);broadcastRoom(room);
  });

  socket.on("toggle_ready",()=>{
    const room=rooms.get(socket.data.roomId),p=room?.players.get(socket.id);
    if(!room||!p||room.started)return;
    p.ready=!p.ready;room.dealerMessage=p.ready?`${p.name} готов к игре`:`${p.name} пока не готов`;broadcastRoom(room);
  });

  socket.on("start_game",()=>{
    const room=rooms.get(socket.data.roomId);if(!room)return;
    try{
      const ps=seatedPlayers(room);
      if(ps.length<2)throw new Error("Для начала нужны минимум 2 игрока");
      if(!ps.every(p=>p.ready))throw new Error("Все игроки должны нажать «Готов»");
      beginHand(room);
    }catch(e){socket.emit("error_message",e.message);}
  });

  socket.on("player_action",({type,amount})=>{
    const room=rooms.get(socket.data.roomId),p=room?.players.get(socket.id);
    if(!room||!p||!room.started)return;
    if(room.currentPlayerId!==socket.id)return socket.emit("error_message","Сейчас ход другого игрока");
    const need=Math.max(0,room.currentBet-p.bet);
    if(type==="fold"){
      p.folded=true;room.acted.add(p.id);room.dealerMessage=`${p.name} — фолд`;
    }else if(type==="check"){
      if(need>0)return socket.emit("error_message",`Нужно уравнять ${need} сом`);
      room.acted.add(p.id);room.dealerMessage=`${p.name} — чек`;
    }else if(type==="call"){
      const paid=postBet(room,p,need);room.acted.add(p.id);room.dealerMessage=`${p.name} — колл ${paid} сом`;
    }else if(type==="raise"){
      let target=Math.max(room.currentBet+room.bigBlind,+amount||0);
      if(target<=room.currentBet)return socket.emit("error_message","Слишком маленький рейз");
      const add=target-p.bet;
      if(add>p.balance)target=p.bet+p.balance;
      postBet(room,p,target-p.bet);room.currentBet=Math.max(room.currentBet,p.bet);
      room.acted=new Set([p.id]);room.dealerMessage=`${p.name} повышает до ${p.bet} сом`;
    }else return;
    io.to(room.id).emit("action_sound",type);
    advanceTurn(room);broadcastRoom(room);
  });

  socket.on("chat_message",text=>{
    const room=rooms.get(socket.data.roomId);if(!room)return;
    const clean=String(text||"").trim().slice(0,250);if(clean)io.to(room.id).emit("chat_message",{name:socket.data.playerName,text:clean,at:Date.now()});
  });

  socket.on("leave_room",()=>leave(socket));
  socket.on("disconnect",()=>leave(socket));
});

function leave(socket){
  const room=rooms.get(socket.data.roomId);if(!room)return;
  const p=room.players.get(socket.id);room.players.delete(socket.id);
  if(p)io.to(room.id).emit("system_message",`${p.name} вышел из комнаты`);
  if(room.players.size===0)rooms.delete(room.id);else broadcastRoom(room);
  socket.data.roomId=null;
}

const port=process.env.PORT||3000;
server.listen(port,()=>console.log(`Poker server started on ${port}`));
