const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_, res) => res.json({ ok: true, rooms: rooms.size }));

const rooms = new Map();
const SB = 25;
const BB = 50;
const START_STACK = 10000;
const PHASES = ['preflop', 'flop', 'turn', 'river'];

function deck() {
  const d=[]; for (const s of ['♠','♥','♦','♣']) for (const r of ['2','3','4','5','6','7','8','9','10','J','Q','K','A']) d.push({r,s});
  for(let i=d.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[d[i],d[j]]=[d[j],d[i]];} return d;
}
const rv=r=>({2:2,3:3,4:4,5:5,6:6,7:7,8:8,9:9,10:10,J:11,Q:12,K:13,A:14}[r]);
function comb(a,k){const o=[];(function f(i,p){if(p.length===k){o.push([...p]);return;}for(let x=i;x<a.length;x++){p.push(a[x]);f(x+1,p);p.pop();}})(0,[]);return o;}
function eval5(cards){
  const vals=cards.map(c=>rv(c.r)).sort((a,b)=>b-a), cnt={}; vals.forEach(v=>cnt[v]=(cnt[v]||0)+1);
  const groups=Object.entries(cnt).map(([v,c])=>({v:+v,c})).sort((a,b)=>b.c-a.c||b.v-a.v);
  const flush=new Set(cards.map(c=>c.s)).size===1; let u=[...new Set(vals)]; if(u.includes(14))u.push(1); let sh=0;
  for(let i=0;i<=u.length-5;i++) if(u[i]-u[i+4]===4){sh=u[i];break;}
  if(flush&&sh)return{score:[8,sh],name:'Стрит-флеш'};
  if(groups[0].c===4)return{score:[7,groups[0].v,groups[1].v],name:'Каре'};
  if(groups[0].c===3&&groups[1]?.c===2)return{score:[6,groups[0].v,groups[1].v],name:'Фулл-хаус'};
  if(flush)return{score:[5,...vals],name:'Флеш'};
  if(sh)return{score:[4,sh],name:'Стрит'};
  if(groups[0].c===3)return{score:[3,groups[0].v,...groups.filter(g=>g.c===1).map(g=>g.v).sort((a,b)=>b-a)],name:'Тройка'};
  const pairs=groups.filter(g=>g.c===2).map(g=>g.v).sort((a,b)=>b-a);
  if(pairs.length>=2)return{score:[2,pairs[0],pairs[1],groups.find(g=>g.c===1).v],name:'Две пары'};
  if(pairs.length===1)return{score:[1,pairs[0],...groups.filter(g=>g.c===1).map(g=>g.v).sort((a,b)=>b-a)],name:'Пара'};
  return{score:[0,...vals],name:'Старшая карта'};
}
function cmp(a,b){for(let i=0;i<Math.max(a.length,b.length);i++){const d=(a[i]||0)-(b[i]||0);if(d)return d;}return 0;}
function best7(cards){let b=null;for(const c of comb(cards,5)){const e=eval5(c);if(!b||cmp(e.score,b.score)>0)b={...e,cards:c};}return b;}

const players=r=>[...r.players.values()].sort((a,b)=>a.seat-b.seat);
const live=r=>players(r).filter(p=>p.inHand&&!p.folded);
const canAct=p=>p.inHand&&!p.folded&&!p.allIn;
function nextPlayer(r, fromId){const ps=players(r);let start=Math.max(-1,ps.findIndex(p=>p.id===fromId));for(let n=1;n<=ps.length;n++){const p=ps[(start+n)%ps.length];if(canAct(p))return p;}return null;}
function nextSeatAmong(list, seat){const s=[...list].sort((a,b)=>a.seat-b.seat);for(const p of s)if(p.seat>seat)return p;return s[0];}
function pay(p,n){const v=Math.max(0,Math.min(p.stack,n));p.stack-=v;p.bet+=v;if(p.stack===0)p.allIn=true;return v;}
function collect(r){for(const p of players(r)){r.pot+=p.bet;p.bet=0;}r.currentBet=0;}
function publicState(r){return{id:r.id,game:r.game,maxPlayers:r.maxPlayers,hostId:r.hostId,started:r.started,phase:r.phase,pot:r.pot,currentBet:r.currentBet,currentPlayerId:r.currentPlayerId,dealerSeat:r.dealerSeat,dealerMessage:r.dealerMessage,community:r.community,smallBlind:SB,bigBlind:BB,players:players(r).map(p=>({id:p.id,name:p.name,seat:p.seat,stack:p.stack,ready:p.ready,inHand:p.inHand,folded:p.folded,allIn:p.allIn,bet:p.bet}))};}
function send(r){io.to(r.id).emit('room_state',publicState(r));}
function say(r,msg){r.dealerMessage=msg;io.to(r.id).emit('dealer_says',msg);}
function resetHand(r){r.started=false;r.phase='waiting';r.pot=0;r.currentBet=0;r.currentPlayerId=null;r.community=[];for(const p of players(r)){p.ready=false;p.inHand=false;p.folded=false;p.allIn=false;p.bet=0;p.cards=[];}setTimeout(()=>send(r),3500);}
function winByFold(r){collect(r);const w=live(r)[0];if(!w)return;const amount=r.pot;w.stack+=amount;say(r,`${w.name} выигрывает ${amount} сом`);io.to(r.id).emit('round_winner',{winners:[w.id],names:w.name,amount,hand:'Все соперники сбросили карты'});send(r);resetHand(r);}
function showdown(r){collect(r);const c=live(r);let top=null,ws=[];for(const p of c){p.result=best7([...p.cards,...r.community]);if(!top||cmp(p.result.score,top.score)>0){top=p.result;ws=[p];}else if(cmp(p.result.score,top.score)===0)ws.push(p);}const amount=r.pot,share=Math.floor(amount/ws.length),rem=amount-share*ws.length;ws.forEach((w,i)=>w.stack+=share+(i===0?rem:0));const names=ws.map(w=>w.name).join(', ');io.to(r.id).emit('showdown',{players:c.map(p=>({id:p.id,name:p.name,cards:p.cards,hand:p.result.name})),winners:ws.map(w=>w.id),amount,hand:top.name,names});say(r,`${names}: ${top.name}. Выигрыш ${amount} сом`);io.to(r.id).emit('round_winner',{winners:ws.map(w=>w.id),names,amount,hand:top.name});send(r);resetHand(r);}
function allInRunout(r){while(r.community.length<5){if(r.community.length===0)r.community.push(r.deck.pop(),r.deck.pop(),r.deck.pop());else r.community.push(r.deck.pop());}r.phase='showdown';showdown(r);}
function roundDone(r){const a=live(r).filter(canAct);return a.length===0||a.every(p=>r.acted.has(p.id)&&p.bet===r.currentBet);}
function beginRound(r,phase){collect(r);r.phase=phase;r.acted=new Set();const first=nextSeatAmong(live(r).filter(canAct),r.dealerSeat);r.currentPlayerId=first?.id||null;const label={flop:'флоп',turn:'тёрн',river:'ривер'}[phase];say(r,`Открыт ${label}. ${first?`Ходит ${first.name}`:'Все игроки олл-ин'}`);if(!first)allInRunout(r);}
function advance(r,actorId){if(live(r).length===1)return winByFold(r);if(roundDone(r)){
  if(r.phase==='preflop'){r.community.push(r.deck.pop(),r.deck.pop(),r.deck.pop());return beginRound(r,'flop');}
  if(r.phase==='flop'){r.community.push(r.deck.pop());return beginRound(r,'turn');}
  if(r.phase==='turn'){r.community.push(r.deck.pop());return beginRound(r,'river');}
  return showdown(r);
}const n=nextPlayer(r,actorId);r.currentPlayerId=n?.id||null;if(!n)return allInRunout(r);say(r,`Ходит ${n.name}`);}
function startHand(r){
  const ready=players(r).filter(p=>p.ready&&p.stack>=BB);if(ready.length<2)throw Error('Нужны минимум 2 готовых игрока с балансом от 50 сом');
  r.started=true;r.phase='preflop';r.deck=deck();r.community=[];r.pot=0;r.currentBet=0;r.acted=new Set();
  const dealer=nextSeatAmong(ready,r.dealerSeat);r.dealerSeat=dealer.seat;
  for(const p of players(r)){p.inHand=ready.includes(p);p.folded=false;p.allIn=false;p.bet=0;p.cards=[];if(p.inHand){p.cards=[r.deck.pop(),r.deck.pop()];io.to(p.id).emit('private_cards',p.cards);}}
  let sb,bb,first;
  if(ready.length===2){sb=dealer;bb=nextSeatAmong(ready,dealer.seat);first=dealer;}else{sb=nextSeatAmong(ready,dealer.seat);bb=nextSeatAmong(ready,sb.seat);first=nextSeatAmong(ready,bb.seat);}
  pay(sb,SB);pay(bb,BB);r.currentBet=BB;r.currentPlayerId=first.id;
  say(r,`Дилер: ${dealer.name}. Блайнды ${SB}/${BB}. Ходит ${first.name}`);send(r);
}

io.on('connection',socket=>{
  socket.on('list_rooms',()=>socket.emit('rooms_list',[...rooms.values()].map(r=>({id:r.id,game:r.game,players:r.players.size,maxPlayers:r.maxPlayers,started:r.started}))));
  socket.on('create_room',({game='Техасский холдем',maxPlayers=6})=>{const id=Math.random().toString(36).slice(2,8).toUpperCase();rooms.set(id,{id,game,maxPlayers:Math.min(8,Math.max(2,+maxPlayers||6)),players:new Map(),hostId:null,started:false,phase:'waiting',pot:0,currentBet:0,currentPlayerId:null,dealerSeat:-1,dealerMessage:'Дилер ждёт игроков',community:[],deck:[],acted:new Set()});socket.emit('room_created',{roomId:id});});
  socket.on('join_room',({roomId,name})=>{const r=rooms.get(String(roomId||'').toUpperCase());if(!r)return socket.emit('error_message','Комната не найдена');if(r.started)return socket.emit('error_message','Раздача уже идёт');if(r.players.size>=r.maxPlayers)return socket.emit('error_message','Стол заполнен');const n=String(name||'').trim().slice(0,20);if(!n)return socket.emit('error_message','Введите имя');if(players(r).some(p=>p.name.toLowerCase()===n.toLowerCase()))return socket.emit('error_message','Это имя занято');const used=new Set(players(r).map(p=>p.seat));let seat=0;while(used.has(seat))seat++;const p={id:socket.id,name:n,seat,stack:START_STACK,ready:false,inHand:false,folded:false,allIn:false,bet:0,cards:[]};r.players.set(socket.id,p);if(!r.hostId)r.hostId=socket.id;socket.join(r.id);socket.data.roomId=r.id;socket.data.name=n;io.to(r.id).emit('system_message',`${n} вошёл в комнату`);send(r);});
  socket.on('toggle_ready',()=>{const r=rooms.get(socket.data.roomId),p=r?.players.get(socket.id);if(!r||!p||r.started)return;p.ready=!p.ready;say(r,`${p.name} ${p.ready?'готов':'не готов'}`);send(r);});
  socket.on('start_game',()=>{const r=rooms.get(socket.data.roomId);if(!r)return;if(socket.id!==r.hostId)return socket.emit('error_message','Начать раздачу может создатель комнаты');if(players(r).some(p=>!p.ready))return socket.emit('error_message','Все игроки должны нажать «Готов»');try{startHand(r);}catch(e){socket.emit('error_message',e.message);}});
  socket.on('player_action',({type,amount})=>{const r=rooms.get(socket.data.roomId),p=r?.players.get(socket.id);if(!r||!p||!r.started)return;if(r.currentPlayerId!==p.id)return socket.emit('error_message','Сейчас ход другого игрока');const need=Math.max(0,r.currentBet-p.bet);
    if(type==='fold'){p.folded=true;r.acted.add(p.id);say(r,`${p.name}: фолд`);} 
    else if(type==='check'){if(need)return socket.emit('error_message',`Нужно поставить ещё ${need} сом`);r.acted.add(p.id);say(r,`${p.name}: чек`);} 
    else if(type==='call'){const v=pay(p,need);r.acted.add(p.id);say(r,`${p.name}: ${need?`колл ${v}`:'чек'}`);} 
    else if(type==='raise'){let target=Math.floor(+amount||0);const min=r.currentBet+BB;if(target<min&&p.stack+p.bet>r.currentBet)return socket.emit('error_message',`Минимальный рейз до ${min} сом`);target=Math.min(target,p.stack+p.bet);if(target<=r.currentBet&&target!==p.stack+p.bet)return socket.emit('error_message','Сумма рейза слишком мала');pay(p,target-p.bet);r.currentBet=Math.max(r.currentBet,p.bet);r.acted=new Set([p.id]);say(r,`${p.name}: рейз до ${p.bet} сом`);}else return;
    io.to(r.id).emit('action_sound',type);advance(r,p.id);send(r);
  });
  socket.on('chat_message',text=>{const r=rooms.get(socket.data.roomId),p=r?.players.get(socket.id);const t=String(text||'').trim().slice(0,250);if(r&&p&&t)io.to(r.id).emit('chat_message',{name:p.name,text:t});});
  socket.on('leave_room',()=>leave(socket));socket.on('disconnect',()=>leave(socket));
});
function leave(socket){const r=rooms.get(socket.data.roomId);if(!r)return;const p=r.players.get(socket.id);r.players.delete(socket.id);if(r.hostId===socket.id)r.hostId=players(r)[0]?.id||null;if(p)io.to(r.id).emit('system_message',`${p.name} вышел`);if(!r.players.size)rooms.delete(r.id);else{if(r.started&&p?.inHand&&!p.folded){p.folded=true;if(live(r).length<=1)winByFold(r);}send(r);}socket.data.roomId=null;}

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Poker server started on ${PORT}`));
module.exports={server,rooms,best7};
