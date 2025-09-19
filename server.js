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

    // Store the room ID on the socket instance for later use
    let currentRoomId = null;

    socket.on('join-room', (roomId) => {
        currentRoomId = roomId; // Store the room ID
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        
        // Announce the new user to others in the room
        socket.to(roomId).emit('user-connected', socket.id);
    });

    // --- These handlers are now correctly placed in the top-level connection scope ---

    socket.on('offer', (payload) => {
        io.to(payload.target).emit('offer', {
            signal: payload.signal,
            caller: socket.id // The caller is the person sending the offer
        });
    });

    socket.on('answer', (payload) => {
        io.to(payload.target).emit('answer', {
            signal: payload.signal,
            caller: socket.id // The caller is the person sending the answer
        });
    });

    socket.on('ice-candidate', (incoming) => {
        // Forward the ICE candidate to the target peer
        io.to(incoming.target).emit('ice-candidate', {
            candidate: incoming.candidate,
            sender: socket.id
        });
    });
    
    // Chat message handler (based on your client-side code)
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
        // Use the stored room ID to notify the correct room
        if (currentRoomId) {
            socket.to(currentRoomId).emit('user-disconnected', socket.id);
        }
    });
});
server.listen(PORT, () => {
    console.log(`Simvo Chat server running on port ${PORT}`);
});