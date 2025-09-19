// Simvo Chat - Signaling Server (Corrected)
// Built with Node.js, Express, and Socket.IO

const express = require('express');
const http = require('http');
const path = require('path'); // <<< --- ADD THIS LINE
const { Server } = require("socket.io");
const { nanoid } = require('nanoid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // In production, restrict this to your Netlify URL for security
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000;

// Serve the frontend static files
app.use(express.static('public'));

app.get('/new-room', (req, res) => {
    // Generate a unique 12-character alphanumeric ID
    const roomId = nanoid(12);
    res.redirect(`/${roomId}`);
});

// <<< --- ADD THIS CATCH-ALL ROUTE --- >>>
// This route must be placed AFTER your other specific GET routes
// but BEFORE the io.on() connection logic.
app.get('/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    socket.on('join-room', async ({ roomId, clientId }) => {
        // --- START OF FIX ---
        // Get a list of all client IDs in the room *before* the new user joins.
        const clientsInRoom = await io.in(roomId).allSockets();
        const otherUsers = Array.from(clientsInRoom);
        
        // Now, join the room.
        socket.join(roomId);
        
        // 1. Tell the new user about everyone who is already there.
        //    This allows the new user to initiate connections to them.
        socket.emit('all-users', otherUsers);

        // 2. Tell everyone else that a new user has joined.
        //    This allows the existing users to initiate a connection to the new one.
        socket.to(roomId).emit('user-connected', socket.id);
        // --- END OF FIX ---

        console.log(`User ${socket.id} (client: ${clientId}) joined room ${roomId}`);
    });

    socket.on('offer', (payload) => {
        io.to(payload.target).emit('offer', {
            signal: payload.signal,
            caller: payload.caller // Pass the original caller's ID
        });
    });

    socket.on('answer', (payload) => {
        io.to(payload.target).emit('answer', {
            signal: payload.signal,
            caller: socket.id // The caller here is the one sending the answer
        });
    });

    socket.on('ice-candidate', (incoming) => {
        io.to(incoming.target).emit('ice-candidate', {
            candidate: incoming.candidate,
            sender: socket.id
        });
    });
    
    socket.on('chat-message', (data) => {
        if (data.roomId) {
            socket.to(data.roomId).emit('chat-message', {
                message: data.message,
                senderId: socket.id
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        // To properly notify the room, we need to iterate over the rooms this socket was in.
        socket.rooms.forEach(room => {
            if (room !== socket.id) {
                socket.to(room).emit('user-disconnected', socket.id);
            }
        });
    });
});
server.listen(PORT, () => {
    console.log(`Simvo Chat server running on port ${PORT}`);
});