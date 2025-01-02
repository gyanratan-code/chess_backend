import express from 'express';
import * as crypto from 'crypto';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { Chess,Move } from 'chess';
import { userInfo } from 'os';
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*', // Allow all origins; adjust to restrict as needed
    methods: ['GET', 'POST'],
  },
});


interface Room {
  authToken: string;
  board: Chess;
  participants: Map<string,string>;
  gameState: boolean;
  clocks: {
    "w": { remainingTime: number, lastMoveTimestamp: number|null },
    "b": { remainingTime: number, lastMoveTimestamp: number|null },
  },
  activePlayer: string,
  timeout?: NodeJS.Timeout;
}
interface MessageParams{
  roomId : string;
  username : string;
  message: Move;
}
interface CreateRoomParams {
  roomId: string;
  username: string;
  authToken: string;
  preference?: string;
}

function generateUniqueId(length: number): string {
  if (length <= 0) {
    throw new Error("Length must be a positive integer");
  }
  const bytes = Math.ceil(length / 2);
  const uniqueId = crypto.randomBytes(bytes).toString('hex');
  // Trim
  return uniqueId.slice(0, length);
}
const rooms: Record<string, Room> = {}; // Store rooms with their details

// Helper function to validate 5-character strings
const isValidId = (id: string): boolean => true;

// Cleanup function to destroy a room after 10 seconds of inactivity
const scheduleRoomCleanup = (roomId: string): void => {
  const room = rooms[roomId];
  if (room?.timeout) {
    clearTimeout(room.timeout);
    console.log(`Existing timeout for room ${roomId} cleared.`);
  }

  room.timeout = setTimeout(() => {
    const roomSize = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    console.log(`Checking room ${roomId}: Size = ${roomSize}`);
    if (roomSize === 0) {
      delete rooms[roomId];
      console.log(`Room ${roomId} has been destroyed.`);
    } else {
      console.log(`Room ${roomId} still has participants, cleanup aborted.`);
    }
  }, 10000);
};

const switchActivePlayer = (roomId) => {
  const room = rooms[roomId];
  const currentTime = Date.now();
  const activePlayer = room.activePlayer;
  const opponentPlayer = activePlayer === 'w' ? 'b' : 'w';

  // Calculate time spent since the last move
  const elapsedTime = (currentTime - room.clocks[activePlayer].lastMoveTimestamp) / 1000;
  room.clocks[activePlayer].remainingTime -= elapsedTime;

  // Check if time has run out
  if (room.clocks[activePlayer].remainingTime <= 0) {
    // \to:do uncomment below line
    // endGame(roomId, opponentPlayer); // Opponent wins
    return;
  }

  // Update timestamps and switch active player
  room.clocks[activePlayer].lastMoveTimestamp = null;
  room.activePlayer = opponentPlayer;
  room.clocks[opponentPlayer].lastMoveTimestamp = currentTime;

  // Schedule the next timeout dynamically for the new active player
  scheduleTimeout(roomId);
};

const scheduleTimeout = (roomId) => {
  const room = rooms[roomId];
  const activePlayer = room.activePlayer;
  const remainingTime = room.clocks[activePlayer].remainingTime;

  // Clear any existing timeout to avoid overlaps
  clearTimeout(room.timeout);

  // Set a new timeout for the active player's remaining time
  room.timeout = setTimeout(() => switchActivePlayer(roomId), remainingTime * 1000);
};

// Main Socket.IO connection logic
io.on('connection', (socket: Socket) => {
  console.log('A user connected:', socket.id);

  // Room creation
  socket.on('createRoom', (params: CreateRoomParams | string,callback: Function) => {
    let parsedParams: CreateRoomParams;
    if (typeof params === 'string') {
      try {
        parsedParams = JSON.parse(params);
      } catch (error) {
        console.error('Invalid JSON received:', params);
        return; // Exit early if JSON is invalid
      }
    } else {
      parsedParams = params;
    }
    const { roomId,username, authToken,preference } = parsedParams;
    if (!isValidId(roomId) || !isValidId(authToken)) {
      return socket.emit('error', 'Invalid roomId or authToken');
    }

    if (rooms[roomId]) {
      return socket.emit('error', 'Room already exists');
    }
    // Create a new room
    const valid= ()=>{
      return (preference==='b' || preference==='w');
    }
    const roomPartcipants= new Map<string,string>();
    const chess = new Chess();
    roomPartcipants.set(username,((preference && valid()) ? preference:(Math.random()>0.5?'w':'b')));
    const opponentUsername= generateUniqueId(6);
    roomPartcipants.set(opponentUsername,(roomPartcipants.get(username)=='w'?'b':'w'));
    console.log(roomPartcipants);
    rooms[roomId] = { authToken:authToken,board:chess, participants: roomPartcipants,gameState:false,clocks:{
      "w":{remainingTime:300,lastMoveTimestamp:null},
      "b":{remainingTime:300,lastMoveTimestamp:null},
    },activePlayer:'w'};
    console.log(`Room ${roomId} created with authToken ${authToken}`);
    callback({ success: true, message: `${opponentUsername}` });
    socket.emit('roomCreated', `Room ${roomId} created with username${opponentUsername}`);
  });

  // Joining an existing room
  socket.on('joinRoom', (params: CreateRoomParams | string) => {
    let parsedParams: CreateRoomParams;
    if (typeof params === 'string') {
      try {
        parsedParams = JSON.parse(params);
      } catch (error) {
        console.error('Invalid JSON received:', params);
        return; // Exit early if JSON is invalid
      }
    } else {
      parsedParams = params;
    }
    const { roomId, authToken,username } = parsedParams;
    if (!isValidId(roomId) || !isValidId(authToken)) {
      return socket.emit('error', 'Invalid roomId or authToken');
    }
    const room = rooms[roomId];
    if (!room) {
      return socket.emit('error', 'Room does not exist');
    }
    if (room.authToken !== authToken) {
      return socket.emit('error', 'Invalid authToken for this room');
    }
    if(socket.rooms.has(roomId)){
      return socket.emit('error', 'Already in the room');
    }
    const currentRoomDetails = io.sockets.adapter.rooms.get(roomId);
    if (currentRoomDetails && currentRoomDetails.size>=2) {
      return socket.emit('error', 'Room is full');
    }
    console.log()
    if(!room.participants.has(username)){
      return socket.emit('error',"You are not part of this room");
    }
    socket.join(roomId);
    console.log(room.participants[username]);
    socket.data.roomId = roomId; // Attach roomId to the socket for tracking
    console.log(room.participants);
    socket.emit('joinedRoom', {"success":true,"fen":room.board.fen()});
    socket.emit("roll",room.participants.get(username));
    if(room.gameState===false && io.sockets.adapter.rooms.get(roomId).size==2){
      io.to(roomId).emit('gameStart');
      room.gameState=true;
    }
  });

  socket.on('sendMessage', (messages: string| MessageParams) => {
    let parsedParams: MessageParams;
    if (typeof messages === 'string') {
      try {
        parsedParams = JSON.parse(messages);
      } catch (error) {
        console.error('Invalid JSON received:', messages);
        return; // Exit early if JSON is invalid
      }
    } else {
      parsedParams = messages;
    }
    const { roomId, message,username } = parsedParams;
    // Check if the user is part of the room
    const room= rooms[roomId];
    if (!room) {
      return socket.emit('error', 'Room does not exist.');
    }
    if (!room.participants.has(username)) {
      return socket.emit('error', 'You are not part of this room.');
    }
    if (!socket.rooms.has(roomId)) {
      return socket.emit('error', 'You have not joined this room.');
    }
    // validate move and then set clocks accordingly
    const colorToMove = String(room.board.turn());
    console.log(colorToMove,room.participants.get(username));
    if(colorToMove!=room.participants.get(username)){
      return socket.emit("error","This is not time to make your move");
    }
    if(room.board.fen() ===message.before){
      try{
        room.board.move({from:message.from,to:message.to});
      }catch(e){
        try{
          room.board.move({from:message.from,to:message.to,promotion:message.promotion});
        }catch(error){
          return socket.emit('error',"Invalid move");
        }
      }
      if(room.board.fen()!==message.after){
        return socket.emit("error","Invalid move");
      }
    }else{
      return socket.emit('error',"Invalid Move");
    }
    switchActivePlayer(roomId);
    io.to(roomId).emit('clockUpdate', {
      w: room.clocks.w.remainingTime,
      b: room.clocks.b.remainingTime,
    });    
    // Broadcast message to all participants except sender
    socket.to(roomId).emit('receiveMessage', { "sender": username,"message": message });
    console.log(`User ${socket.id} sent message to room ${roomId}: "${message}"`);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    console.log(`User ${socket.id} is disconnecting...`);
    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      const roomDetails= io.sockets.adapter.rooms.get(roomId);
      if (roomDetails==null ||roomDetails.size===0) {
        console.log(`Room ${roomId} is empty. Scheduling cleanup...`);
        scheduleRoomCleanup(roomId);
      }
    } else {
      console.log(`User ${socket.id} was not associated with any room.`);
    }
    delete socket.data.roomId;
  });

});
server.listen(process.env.port||3001, () => {
  console.log('Server running on http://localhost:3001');
});
