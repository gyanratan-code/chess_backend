// load the configuration from .env file
import dotenv from "dotenv";
dotenv.config();
// import all necessary thing for server to run
import { createClient } from 'redis';
import { createAdapter } from "@socket.io/redis-adapter";
import cors from "cors";
import { validateJwt ,AuthRequest } from "./middleware/validateJwt.js";
import jwt, { Secret, SignOptions } from "jsonwebtoken";
import cookie from "cookie";
import cookieParser from "cookie-parser";
import authRouter from "./routes/auth.js";

import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { Chess,Move } from 'chess';
import {RoomParams,MessageParams,generateUniqueId,joinRoomParams} from "./dataType/type.js"
// debug parameter set to false;
const dbg= false;

const app = express();
app.get('/', (req, res) => {
  res.send('Good Job,Keep this instance active');
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: '*',
    },
  }
);
// middleware
app.use(express.json());
app.use(cors({
  origin: "*",
  methods: "*",
}));
app.use(cookieParser());

// protected routes to fetch profile
app.get(
  "/profile",
  validateJwt,
  (req: AuthRequest, res) => {
    res.json({ id: req.user!.sub, username: req.user!.username });
  }
);
app.use(authRouter);

// handshake logic
io.use((socket, next) => {
  const raw = socket.handshake.headers.cookie;
  if (!raw) return next(new Error("Auth error"));
  const { token } = cookie.parse(raw);
  if (!token) return next(new Error("Auth error"));
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET!) as {
      sub: string;
      username: string;
    };
    (socket as any).user = payload;
    socket.data.user = payload;
    next();
  } catch {
    next(new Error("Auth error"));
  }
});

//Redis adapter for scaling
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await Promise.all([pubClient.connect(), subClient.connect()]);
io.adapter(createAdapter(pubClient, subClient));
pubClient.on("error", err => console.error("Redis Client Error", err));
subClient.on("error", err => console.error("Redis Subscriber Error", err));

const timeouts = new Map<string, NodeJS.Timeout>();

// switch the active player
const switchActivePlayer = async (roomId: string) => {
  const key = `room:${roomId}`;
  // Load room details from redis database
  const data:any = await pubClient.hGetAll(key);
  if (data.active !== "true") return;

  const now = Date.now();
  const active = data.activeColor as "w" | "b";
  const opponent = active === "w" ? "b" : "w";

  // Parse clock
  const clockField = active === "w" ? "clockW" : "clockB";
  const clock = JSON.parse(data[clockField]) as {
    remainingTime: number;
    lastTimestamp: number;
  };

  // deduct elapsed time
  const elapsed = now - clock.lastTimestamp;
  clock.remainingTime -= elapsed;

  // Handling timeout based loss
  if (clock.remainingTime <= 0) {
    clock.remainingTime = 0;
    const winnerName = opponent === "w" ? "White" : "Black";
    const result = `${winnerName} wins on time.`;
    // store final state in redis database
    await pubClient.hSet(key, {
      [clockField]: JSON.stringify({ remainingTime: 0, lastTimestamp: null }),
      active: "false",
      result,
    });
    // emit gameEnd signal
    io.to(roomId).emit("gameEnd", result);
    // clear pending timeout
    if (timeouts.has(roomId)) {
      clearTimeout(timeouts.get(roomId));
      timeouts.delete(roomId);
    }
    return;
  }

  //Switch active player
  const oppField = opponent === "w" ? "clockW" : "clockB";
  const oppClock = JSON.parse(data[oppField]) as {
    remainingTime: number;
    lastTimestamp: number | null;
  };

  // Persist updated clocks & activeColor
  await pubClient.hSet(key, {
    [clockField]: JSON.stringify({ remainingTime: clock.remainingTime, lastTimestamp: null }),
    activeColor: opponent,
    [oppField]: JSON.stringify({ remainingTime: oppClock.remainingTime, lastTimestamp: now }),
  });

  // Broadcast updated clocks
  const rawClockW = await pubClient.hGet(`room:${roomId}`, 'clockW');
  if (!rawClockW) throw new Error('Missing clockW');
  const clockW = JSON.parse(rawClockW.toString());
  const wRemaining = clockW.remainingTime;

  const rawClockB = await pubClient.hGet(`room:${roomId}`, 'clockB');
  if (!rawClockB) throw new Error('Missing clockB');
  const clockB = JSON.parse(rawClockB.toString());
  const bRemaining = clockB.remainingTime;

  io.to(roomId).emit('clockUpdate', {
    w: wRemaining,
    b: bRemaining,
  });

  //Schedule next timeout
  scheduleTimeout(roomId);
};

// Handling schedule TimeOut
const scheduleTimeout = async (roomId: string) => {
  // clear existing timeout if any
  if (timeouts.has(roomId)) {
    clearTimeout(timeouts.get(roomId)!);
  }
  const key = `room:${roomId}`;
  // load details of game from redis
  const data:any = await pubClient.hGetAll(key);
  if (data.active !== "true") return;
  // time left for the active player
  const active = data.activeColor as "w" | "b";
  const clockField = active === "w" ? "clockW" : "clockB";
  const clock = JSON.parse(data[clockField]) as {
    remainingTime: number;
    lastTimestamp: number;
  };
  // schedule the switch
  const to = setTimeout(() => switchActivePlayer(roomId), clock.remainingTime);
  timeouts.set(roomId, to);
};


io.on('connection', async (socket: Socket & { data: { user: { sub: string; username: string } } }) => {
  const { sub: userId, username } = socket.data.user;
  dbg && console.log(`User ${username} (${userId}) connected: socket ${socket.id}`);

  // create room logic
  socket.on('createRoom', async (params: RoomParams | string, callback: Function) => {
    // Parse params of room
    let p: RoomParams;
    if (typeof params === 'string') {
      try { p = JSON.parse(params); }
      catch { return socket.emit('error', 'Invalid createRoom payload'); }
    } else {
      p = params;
    }
    const { opponentUsername,preference, time } = p;
    // \to:can be improved, generating random roomId
    const roomId = generateUniqueId(8);
    // Check that this roomId does not exist
    if (await pubClient.exists(`room:${roomId}`)) {
      return socket.emit('error', 'Room already exists');
    }

    // Intialise game and users
    const chess = new Chess();
    const userRole = (preference === 'w' || preference === 'b')
      ? preference
      : Math.random() > 0.5 ? 'w' : 'b';
    const opponentRole = (userRole === 'w' ? 'b' : 'w');

    // store intial room details in redis
    const initialClock = JSON.stringify({ remainingTime: time || 300000, lastTimestamp: null });
    await pubClient.hSet(`room:${roomId}`, {
      fen: chess.fen(),
      moves: JSON.stringify([]),
      whitePlayer: username,
      blackPlayer: opponentUsername,
      active: 'false',
      activeColor: 'w',
      clockW: initialClock,
      clockB: initialClock,
    });
    // auto cleanup for room expiry
    await pubClient.expire(`room:${roomId}`, 3600);

    // room created's deatil added to socket
    socket.join(roomId);
    socket.data.roomId = roomId
    callback({
      success: true,
      roomId : roomId, 
      userRole: userRole, 
      opponentRole: opponentRole 
    });
  });

  // join room logic
  socket.on('joinRoom', async (params: joinRoomParams | string) => {
    let p: joinRoomParams;
    if (typeof params === 'string') {
      try { p = JSON.parse(params); }
      catch { return socket.emit('error', 'Invalid joinRoom payload'); }
    } else {
      p = params;
    }
    const { roomId } = p;

    // load room details from redis
    if (!(await pubClient.exists(`room:${roomId}`))) {
      return socket.emit('error', 'Room does not exist');
    }
    const data:any = await pubClient.hGetAll(`room:${roomId}`);

    // User eligibility
    // if username has not been set to intially means any user can join it
    if(data.whitePlayer===null && data.blackPlayer!==username){
      data.whitePlayer = username;
    }
    if(data.blackPlayer=== null && data.whitePlayer!==username){
      data.blackPlayer = username;
    }
    if (username !== data.whitePlayer && username !== data.blackPlayer) {
      return socket.emit('error', 'You are not part of this room');
    }
    // Prevent duplicates & over‑full
    const clients = io.sockets.adapter.rooms.get(roomId);
    if (clients?.has(socket.id)) {
      return socket.emit('error', 'Already in the room');
    }
    if (clients && clients.size >= 2) {
      return socket.emit('error', 'Room is full');
    }
    // join
    socket.join(roomId);
    socket.data.roomId = roomId;

    // Notify client
    const fen    = data.fen;
    const active = (data.active === 'true');
    const roll   = (username === data.whitePlayer ? 'w' : 'b');
    socket.emit('joinedRoom', { success: true, fen, gameState: active, roll });

    //  On second join -> start game
    if (!active && io.sockets.adapter.rooms.get(roomId)?.size === 2) {
      io.to(roomId).emit('gameStart');
      await pubClient.hSet(`room:${roomId}`, { active: 'true' });

      const now = Date.now();
      await Promise.all([
        pubClient.hSet(`room:${roomId}`, { clockW: JSON.stringify({ remainingTime: JSON.parse(data.clockW).remainingTime, lastTimestamp: now }) }),
        pubClient.hSet(`room:${roomId}`, { clockB: JSON.stringify({ remainingTime: JSON.parse(data.clockB).remainingTime, lastTimestamp: now }) }),
      ]);

      const rawClockW = await pubClient.hGet(`room:${roomId}`, 'clockW');
      if (!rawClockW) throw new Error('Missing clockW');
      const clockW = JSON.parse(rawClockW.toString());
      const wRemaining = clockW.remainingTime;

      const rawClockB = await pubClient.hGet(`room:${roomId}`, 'clockB');
      if (!rawClockB) throw new Error('Missing clockB');
      const clockB = JSON.parse(rawClockB.toString());
      const bRemaining = clockB.remainingTime;

      io.to(roomId).emit('clockUpdate', {
        w: wRemaining,
        b: bRemaining,
      });
      // Schedule the first timeout
      scheduleTimeout(roomId);
    }
  });

  // send move as message
  socket.on('sendMessage', async (msg: string | MessageParams) => {
    let p: MessageParams;
    if (typeof msg === 'string') {
      try { p = JSON.parse(msg); }
      catch { return socket.emit('error', 'Invalid message payload'); }
    } else {
      p = msg;
    }
    const roomId = socket.data.roomId
    // load room details from redis
    const data:any = await pubClient.hGetAll(`room:${roomId}`);
    if(!(data)){
      return socket.emit('error', 'Room does not exist');
    }
    // Game Active state
    if (data.active !== 'true') {
      return socket.emit('error', 'Game has ended');
    }
    const chess = new Chess(data.fen);
    const colorToMove = chess.turn();
    const playerColor = username === data.whitePlayer ? 'w' : 'b';
    if (colorToMove !== playerColor) {
      return socket.emit('error', 'Not your turn');
    }
    // Validate previous game state
    if (data.fen !== p.message.before) {
      console.log(`data.fen:${data.fen}, before:${p.message.before}`);
      return socket.emit('error', 'Stale game state');
    }
    // make a move server side
    let moveResult = chess.move({ from: p.message.from, to: p.message.to, promotion: p.message.promotion });
    if (!moveResult || chess.fen() !== p.message.after) {
      return socket.emit('error', 'Invalid move');
    }

    // updated FEN & moves in redis
    const moves = JSON.parse(data.moves) as any[];
    moves.push(p.message);
    await pubClient.hSet(`room:${roomId}`, {
      fen: chess.fen(),
      moves: JSON.stringify(moves),
    });

    // Advance clocks & schedule next timeout
    await switchActivePlayer(roomId);

    // Broadcast clock updates
    const rawClockW = await pubClient.hGet(`room:${roomId}`, 'clockW');
    if (!rawClockW) throw new Error('Missing clockW');
    const clockW = JSON.parse(rawClockW.toString());
    const wRemaining = clockW.remainingTime;

    const rawClockB = await pubClient.hGet(`room:${roomId}`, 'clockB');
    if (!rawClockB) throw new Error('Missing clockB');
    const clockB = JSON.parse(rawClockB.toString());
    const bRemaining = clockB.remainingTime;

    io.to(roomId).emit('clockUpdate', {
      w: wRemaining,
      b: bRemaining,
    });
    // Relay the move to the opponent
    socket.to(roomId).emit('receiveMessage', { sender: username, message: p });
  });

  // disconnect logic
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    dbg && console.log(`Socket ${socket.id} disconnected`);

    if (!roomId) return;

    // Tell the other player (if any) that someone left
    io.to(roomId).emit('leftRoom', {
      action: 'disconnected',
      username: socket.data.user.username,
    });
  })
});

server.listen(process.env.port||3001, () => {
  dbg && console.log('Server running on http://localhost:3001');
});
