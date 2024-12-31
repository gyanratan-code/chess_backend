import express from 'express';
import http from 'http';
import { Server, Socket } from 'socket.io';
import { Chess,Move } from 'chess';
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
  participants: string[]; // List of socket IDs
  timeout?: NodeJS.Timeout;
}
interface MessageParams{
  roomId : string;
  message: Move;
}
interface CreateRoomParams {
  roomId: string;
  authToken: string;
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

// Main Socket.IO connection logic
io.on('connection', (socket: Socket) => {
  console.log('A user connected:', socket.id);

  // Room creation
  socket.on('createRoom', (params: CreateRoomParams | string) => {
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
    const { roomId, authToken } = parsedParams;
    if (!isValidId(roomId) || !isValidId(authToken)) {
      return socket.emit('error', 'Invalid roomId or authToken');
    }

    if (rooms[roomId]) {
      return socket.emit('error', 'Room already exists');
    }

    // Create a new room
    rooms[roomId] = { authToken, participants: [] };
    console.log(`Room ${roomId} created with authToken ${authToken}`);
    socket.emit('roomCreated', `Room ${roomId} created but not joined`);
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
    const { roomId, authToken } = parsedParams;
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
    if(room.participants.includes(socket.id)){
      return socket.emit('error', 'Already in the room',room.participants.length,room.participants);
    }
    if (room.participants.length >= 2) {
      return socket.emit('error', 'Room is full');
    }

    socket.join(roomId);
    room.participants.push(socket.id);
    socket.data.roomId = roomId; // Attach roomId to the socket for tracking
    console.log(`User ${socket.id} joined room ${roomId}`);
    socket.emit('joinedRoom', `Successfully joined room ${roomId}`);
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
    const { roomId, message } = parsedParams;
    // Check if the user is part of the room
    if (!socket.rooms.has(roomId)) {
      return socket.emit('error', 'You are not part of this room.');
    }

    // Broadcast message to all participants except sender
    socket.to(roomId).emit('receiveMessage', { "sender": socket.id,"message": message });
    console.log(`User ${socket.id} sent message to room ${roomId}: "${message}"`);
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    console.log(`User ${socket.id} is disconnecting...`);

    if (roomId && rooms[roomId]) {
      const room = rooms[roomId];
      room.participants = room.participants.filter((id) => id !== socket.id);
      console.log(`User ${socket.id} removed from room ${roomId}. Remaining participants: ${room.participants.length}`);

      if (room.participants.length === 0) {
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
  console.log('Server running on http://localhost:3000');
});
