// Simvo Chat - Frontend WebRTC Logic (Robust Version)

// --- STATE MANAGEMENT ---
let localStream;
let isMicOn = true;
let isVideoOn = true;
let peers = {}; // To store peer connections

// --- INITIALIZATION ---
const ROOM_ID = window.location.pathname.substring(1);
const socket = io('https://simvo-chat-server.onrender.com'); 

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- DOM ELEMENTS (Lazy Loaded) ---
const homepage = document.getElementById('homepage');
const room = document.getElementById('room');
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');

// --- CORE LOGIC ---
const handlePath = () => {
    if (ROOM_ID) {
        // We are in a room
        homepage.classList.remove('active');
        room.classList.add('active');
        initializeRoom();
    } else {
        // We are on the homepage
        homepage.classList.add('active');
        room.classList.remove('active');
        initializeHomepage();
    }
};

const initializeHomepage = () => {
    const startBtn = document.getElementById('start-btn');
    // Check if the button exists before adding listener
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            // Generate a room ID client-side and navigate
            const newRoomId = Math.random().toString(36).substring(2, 14);
            window.location.href = `/${newRoomId}`;
        });
    }
};

const initializeRoom = async () => {
    // Initialize room controls ONLY when we are in a room
    const micBtn = document.getElementById('mic-btn');
    const videoBtn = document.getElementById('video-btn');
    const endCallBtn = document.getElementById('end-call-btn');
    const fullscreenBtn = document.getElementById('fullscreen-btn');

    if (micBtn) micBtn.addEventListener('click', toggleMic);
    if (videoBtn) videoBtn.addEventListener('click', toggleVideo);
    if (endCallBtn) endCallBtn.addEventListener('click', () => { window.location.href = '/'; });
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', () => { document.body.classList.toggle('fullscreen-active'); });

    // Start the camera and join the socket room
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        socket.emit('join-room', ROOM_ID);
    } catch (error) {
        console.error('Failed to get local stream', error);
        alert('Could not access your camera and microphone. Please check permissions.');
    }
};

const toggleMic = () => {
    isMicOn = !isMicOn;
    localStream.getAudioTracks()[0].enabled = isMicOn;
    document.getElementById('mic-btn').classList.toggle('active', isMicOn);
};

const toggleVideo = () => {
    isVideoOn = !isVideoOn;
    localStream.getVideoTracks()[0].enabled = isVideoOn;
    document.getElementById('video-btn').classList.toggle('active', isVideoOn);
};

// --- WEBRTC & SOCKET.IO EVENT HANDLING --- (No changes below this line)

socket.on('user-connected', (userId) => {
    console.log(`New user connected: ${userId}`);
    callUser(userId);
});

socket.on('offer', async (payload) => {
    console.log(`Received offer from ${payload.caller}`);
    const peerConnection = createPeerConnection(payload.caller);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.signal));
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', { target: payload.caller, signal: answer });
});

socket.on('answer', (payload) => {
    console.log(`Received answer from ${payload.caller}`);
    const peerConnection = peers[payload.caller];
    peerConnection.setRemoteDescription(new RTCSessionDescription(payload.signal));
});

socket.on('ice-candidate', (payload) => {
    const peerConnection = peers[payload.sender];
    if (peerConnection) {
        peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
    }
});

socket.on('user-disconnected', (userId) => {
    console.log(`User disconnected: ${userId}`);
    if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
    }
    const videoElement = document.getElementById(userId);
    if (videoElement) {
        videoElement.parentElement.remove();
    }
});

// --- HELPER FUNCTIONS ---

const createPeerConnection = (userId) => {
    const peerConnection = new RTCPeerConnection(configuration);
    peers[userId] = peerConnection;

    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    peerConnection.ontrack = (event) => {
        addRemoteStream(userId, event.streams[0]);
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', { target: userId, candidate: event.candidate });
        }
    };

    return peerConnection;
};

const callUser = async (userId) => {
    const peerConnection = createPeerConnection(userId);
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('offer', { target: userId, signal: offer, caller: socket.id });
};

const addRemoteStream = (userId, stream) => {
    if (document.getElementById(userId)) return;

    const videoContainer = document.createElement('div');
    videoContainer.classList.add('video-container');
    
    const remoteVideo = document.createElement('video');
    remoteVideo.id = userId;
    remoteVideo.srcObject = stream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;

    const nameTag = document.createElement('span');
    nameTag.classList.add('name-tag');
    nameTag.innerText = 'Peer';

    videoContainer.appendChild(remoteVideo);
    videoContainer.appendChild(nameTag);
    videoGrid.appendChild(videoContainer);
};

// --- RUN ---
handlePath();