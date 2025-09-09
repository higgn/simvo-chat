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

    socket.on('join-room', (roomId) => {
        socket.join(roomId);
        console.log(`User ${socket.id} joined room ${roomId}`);
        
        socket.to(roomId).emit('user-connected', socket.id);

        socket.on('offer', (payload) => {
            io.to(payload.target).emit('offer', {
                signal: payload.signal,
                caller: payload.caller
            });
        });

        socket.on('answer', (payload) => {
            io.to(payload.target).emit('answer', {
                signal: payload.signal,
                caller: socket.id
            });
        });

        socket.on('ice-candidate', (incoming) => {
            io.to(incoming.target).emit('ice-candidate', {
                candidate: incoming.candidate,
                sender: socket.id
            });
        });

        socket.on('disconnect', () => {
            console.log(`User disconnected: ${socket.id}`);
            // Note: To properly notify the room, the roomId needs to be accessible here.
            // A more robust implementation would store the user's room. For now, this is fine.
            // A simple fix would be to iterate over the rooms the socket was in.
            const rooms = Object.keys(socket.rooms);
            rooms.forEach(room => {
                if(room !== socket.id) {
                     socket.to(room).emit('user-disconnected', socket.id);
                }
            })
        });
    });
});

server.listen(PORT, () => {
    console.log(`Simvo Chat server running on port ${PORT}`);
});