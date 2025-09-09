// Simvo Chat - Frontend WebRTC Logic

// --- DOM ELEMENTS ---
const homepage = document.getElementById('homepage');
const room = document.getElementById('room');
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');
const micBtn = document.getElementById('mic-btn');
const videoBtn = document.getElementById('video-btn');
const endCallBtn = document.getElementById('end-call-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');

// --- STATE MANAGEMENT ---
let localStream;
let isMicOn = true;
let isVideoOn = true;
let peers = {}; // To store peer connections

// --- INITIALIZATION ---
// Connect to the signaling server.
// In development, this points to localhost. In production, change this to your Render/Heroku URL.
const socket = io('https://simvo-chat-server.onrender.com'); 
const ROOM_ID = window.location.pathname.substring(1);

// WebRTC STUN servers (using public Google servers)
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- CORE LOGIC ---
const handlePath = () => {
    if (ROOM_ID) {
        homepage.classList.remove('active');
        room.classList.add('active');
        startChat();
    } else {
        homepage.classList.add('active');
        room.classList.remove('active');
    }
};

const startChat = async () => {
    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = localStream;
        socket.emit('join-room', ROOM_ID);
    } catch (error) {
        console.error('Failed to get local stream', error);
        alert('Could not access your camera and microphone. Please check permissions.');
    }
};

// --- WEBRTC & SOCKET.IO EVENT HANDLING ---

socket.on('user-connected', (userId) => {
    console.log(`New user connected: ${userId}`);
    // As the existing user, I will create and send an offer
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

    // Add local stream tracks to the connection
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // Handle incoming remote stream
    peerConnection.ontrack = (event) => {
        addRemoteStream(userId, event.streams[0]);
    };

    // Handle ICE candidates
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
    if (document.getElementById(userId)) return; // Avoid duplicate videos

    const videoContainer = document.createElement('div');
    videoContainer.classList.add('video-container');
    
    const remoteVideo = document.createElement('video');
    remoteVideo.id = userId;
    remoteVideo.srcObject = stream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;

    const nameTag = document.createElement('span');
    nameTag.classList.add('name-tag');
    nameTag.innerText = 'Peer'; // Or a generated name

    videoContainer.appendChild(remoteVideo);
    videoContainer.appendChild(nameTag);
    videoGrid.appendChild(videoContainer);
};

// --- UI CONTROLS ---

micBtn.addEventListener('click', () => {
    isMicOn = !isMicOn;
    localStream.getAudioTracks()[0].enabled = isMicOn;
    micBtn.classList.toggle('active', isMicOn);
    // Update SVG icon if needed
});

videoBtn.addEventListener('click', () => {
    isVideoOn = !isVideoOn;
    localStream.getVideoTracks()[0].enabled = isVideoOn;
    videoBtn.classList.toggle('active', isVideoOn);
    // Update SVG icon if needed
});

endCallBtn.addEventListener('click', () => {
    window.location.href = '/';
});

fullscreenBtn.addEventListener('click', () => {
    document.body.classList.toggle('fullscreen-active');
});

// --- RUN ---
handlePath();