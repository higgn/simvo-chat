// Simvo Chat - Frontend WebRTC Logic (v2 - Feature Enhanced)

// --- STATE MANAGEMENT ---
let localStream;
let isMicOn = true;
let isVideoOn = true;
let isScreenSharing = false;
let isNoiseSuppressionEnabled = true;
let peers = {};
let videoDevices = [];
let currentVideoDeviceIndex = 0;
let participantCount = 1;
let connectionStatus = 'connected';

// --- INITIALIZATION ---
const ROOM_ID = window.location.pathname.substring(1);
const socket = io('https://simvo-chat-server.onrender.com'); 

const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- DOM ELEMENTS (Lazy Loaded in their respective initializers) ---
const homepage = document.getElementById('homepage');
const room = document.getElementById('room');
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');

// --- CORE LOGIC & ROUTING ---
const handlePath = () => {
    if (ROOM_ID) {
        homepage.classList.remove('active');
        room.classList.add('active');
        initializeRoom();
    } else {
        homepage.classList.add('active');
        room.classList.remove('active');
        initializeHomepage();
    }
};

const initializeHomepage = () => {
    const startBtn = document.getElementById('start-btn');
    if (startBtn) {
        startBtn.addEventListener('click', () => {
            const newRoomId = Math.random().toString(36).substring(2, 14);
            window.location.href = `/${newRoomId}`;
        });
    }
};

const joinRoom = () => {
    const roomId = prompt('Enter Room ID to join:');
    if (roomId && roomId.trim()) {
        window.location.href = `/${roomId.trim()}`;
    }
};

const initializeRoom = async () => {
    // A. Initialize UI Controls
    initializeControls();

    // B. Get available media devices
    await getVideoDevices();

    // C. Start the camera and join the socket room
    try {
        await startMedia();
        socket.emit('join-room', ROOM_ID);
    } catch (error) {
        console.error('Failed to get local stream', error);
        alert('Could not access your camera and microphone. Please check permissions.');
    }
};

// --- FEATURE IMPLEMENTATIONS ---

async function startMedia(videoDeviceId = undefined, audioSettings = { echoCancellation: true, noiseSuppression: true }) {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    const videoConstraints = {
        deviceId: videoDeviceId ? { exact: videoDeviceId } : undefined,
        width: { ideal: 1280 },
        height: { ideal: 720 }
    };
    
    localStream = await navigator.mediaDevices.getUserMedia({ 
        video: videoConstraints, 
        audio: audioSettings 
    });

    localVideo.srcObject = localStream;
    // When starting media, ensure tracks are sent to existing peers
    updateAllPeerTracks();
}

async function getVideoDevices() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        videoDevices = devices.filter(device => device.kind === 'videoinput');
        const flipCameraBtn = document.getElementById('flip-camera-btn');
        if (videoDevices.length > 1) {
            flipCameraBtn.style.display = 'flex';
        }
    } catch (error) {
        console.error('Error enumerating devices:', error);
    }
}

async function flipCamera() {
    if (videoDevices.length < 2) return;
    if (isScreenSharing) await toggleScreenShare(); // Stop screen share first

    currentVideoDeviceIndex = (currentVideoDeviceIndex + 1) % videoDevices.length;
    const newVideoDevice = videoDevices[currentVideoDeviceIndex];
    
    // Get new video stream
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: newVideoDevice.deviceId } } });
    const newVideoTrack = newStream.getVideoTracks()[0];

    // Update local video
    localVideo.srcObject = newStream;
    // Replace the track for all peers
    await replaceTrackForPeers(newVideoTrack);
    // Update local stream reference
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(newVideoTrack);
}

async function toggleScreenShare() {
    const screenShareBtn = document.getElementById('screen-share-btn');
    if (!isScreenSharing) {
        try {
            const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const screenTrack = screenStream.getVideoTracks()[0];
            
            await replaceTrackForPeers(screenTrack);
            isScreenSharing = true;
            localVideo.srcObject = screenStream;
            localVideo.style.transform = 'scaleX(1)'; // Don't mirror screen share
            screenShareBtn.classList.add('active');
            screenShareBtn.title = 'Stop sharing';

            // When user clicks browser's "Stop sharing" button
            screenTrack.onended = () => {
                toggleScreenShare(); // This will trigger the 'else' block
            };
        } catch (error) {
            console.error('Error sharing screen:', error);
        }
    } else {
        // Get new camera stream
        const videoConstraints = {
            deviceId: videoDevices[currentVideoDeviceIndex]?.deviceId ? 
                { exact: videoDevices[currentVideoDeviceIndex].deviceId } : undefined,
            width: { ideal: 1280 },
            height: { ideal: 720 }
        };
        
        const cameraStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints });
        const cameraTrack = cameraStream.getVideoTracks()[0];
        
        await replaceTrackForPeers(cameraTrack);
        isScreenSharing = false;
        
        // Update local stream
        const oldVideoTrack = localStream.getVideoTracks()[0];
        localStream.removeTrack(oldVideoTrack);
        localStream.addTrack(cameraTrack);
        
        localVideo.srcObject = localStream;
        localVideo.style.transform = 'scaleX(-1)';
        screenShareBtn.classList.remove('active');
        screenShareBtn.title = 'Share screen';
    }
}

async function toggleNoiseSuppression(enabled) {
    isNoiseSuppressionEnabled = enabled;
    // Get a new audio track with the desired setting
    const newAudioStream = await navigator.mediaDevices.getUserMedia({ audio: { noiseSuppression: enabled, echoCancellation: true } });
    const newAudioTrack = newAudioStream.getAudioTracks()[0];
    await replaceTrackForPeers(newAudioTrack, 'audio');
    // Update local stream reference
    localStream.removeTrack(localStream.getAudioTracks()[0]);
    localStream.addTrack(newAudioTrack);
}

function applyVideoFilter(filter) {
    document.querySelectorAll('#video-grid video').forEach(v => {
        v.style.filter = filter;
    });
}

// --- UTILITY FUNCTIONS ---

async function replaceTrackForPeers(newTrack, kind = 'video') {
    for (const peerId in peers) {
        const peerConnection = peers[peerId];
        const sender = peerConnection.getSenders().find(s => s.track.kind === kind);
        if (sender) {
            await sender.replaceTrack(newTrack);
        }
    }
}

function updateAllPeerTracks() {
    for (const peerId in peers) {
        const peerConnection = peers[peerId];
        localStream.getTracks().forEach(track => {
            const sender = peerConnection.getSenders().find(s => s.track.kind == track.kind);
            if(sender) {
                sender.replaceTrack(track);
            }
        });
    }
}

// --- CHAT FUNCTIONALITY ---
let chatMessages = [];
let isChatOpen = false;

function toggleChat() {
    const chatPanel = document.getElementById('chat-panel');
    const chatToggleBtn = document.getElementById('chat-toggle-btn');
    
    isChatOpen = !isChatOpen;
    
    if (isChatOpen) {
        chatPanel.classList.add('active');
        chatToggleBtn.classList.add('active');
    } else {
        chatPanel.classList.remove('active');
        chatToggleBtn.classList.remove('active');
    }
}

function sendMessage() {
    const chatInput = document.getElementById('chat-input');
    const message = chatInput.value.trim();
    
    if (message) {
        const messageData = {
            text: message,
            timestamp: new Date().toLocaleTimeString(),
            sender: 'own'
        };
        
        addMessageToChat(messageData);
        socket.emit('chat-message', { roomId: ROOM_ID, message: messageData });
        chatInput.value = '';
        adjustTextareaHeight(chatInput);
    }
}

function addMessageToChat(messageData) {
    const chatMessages = document.getElementById('chat-messages');
    const messageElement = document.createElement('div');
    messageElement.className = `message ${messageData.sender}`;
    
    messageElement.innerHTML = `
        <div>${messageData.text}</div>
        <div class="message-time">${messageData.timestamp}</div>
    `;
    
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function adjustTextareaHeight(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
}

function updateIconState(button, isActive, onIcon, offIcon) {
    const onSvg = button.querySelector(onIcon);
    const offSvg = button.querySelector(offIcon);
    
    if (isActive) {
        if (onSvg) onSvg.style.display = 'block';
        if (offSvg) offSvg.style.display = 'none';
        button.classList.add('active');
        button.classList.remove('muted');
    } else {
        if (onSvg) onSvg.style.display = 'none';
        if (offSvg) offSvg.style.display = 'block';
        button.classList.remove('active');
        button.classList.add('muted');
    }
}

// --- UI CONTROLS INITIALIZER ---
function initializeControls() {
    const micBtn = document.getElementById('mic-btn');
    const videoBtn = document.getElementById('video-btn');
    const endCallBtn = document.getElementById('end-call-btn');
    const screenShareBtn = document.getElementById('screen-share-btn');
    const flipCameraBtn = document.getElementById('flip-camera-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const chatToggleBtn = document.getElementById('chat-toggle-btn');
    const chatCloseBtn = document.getElementById('chat-close');
    const sendMessageBtn = document.getElementById('send-message');
    const chatInput = document.getElementById('chat-input');
    const settingsModal = document.getElementById('settings-modal');
    const closeModalBtn = document.querySelector('.close-button');
    const noiseSuppressionToggle = document.getElementById('noise-suppression-toggle');
    const videoFilterSelect = document.getElementById('video-filter-select');

    // Microphone control with icon states
    if (micBtn) micBtn.addEventListener('click', () => {
        isMicOn = !isMicOn;
        localStream.getAudioTracks()[0].enabled = isMicOn;
        updateIconState(micBtn, isMicOn, '.mic-on', '.mic-off');
        micBtn.title = isMicOn ? 'Mute microphone' : 'Unmute microphone';
    });

    // Video control with icon states
    if (videoBtn) videoBtn.addEventListener('click', () => {
        isVideoOn = !isVideoOn;
        localStream.getVideoTracks()[0].enabled = isVideoOn;
        updateIconState(videoBtn, isVideoOn, '.video-on', '.video-off');
        videoBtn.title = isVideoOn ? 'Turn off camera' : 'Turn on camera';
    });

    // Other controls
    if (endCallBtn) endCallBtn.addEventListener('click', () => { window.location.href = '/'; });
    if (screenShareBtn) screenShareBtn.addEventListener('click', toggleScreenShare);
    if (flipCameraBtn) flipCameraBtn.addEventListener('click', flipCamera);
    
    // Chat controls
    if (chatToggleBtn) chatToggleBtn.addEventListener('click', toggleChat);
    if (chatCloseBtn) chatCloseBtn.addEventListener('click', toggleChat);
    if (sendMessageBtn) sendMessageBtn.addEventListener('click', sendMessage);
    
    // Chat input handling
    if (chatInput) {
        chatInput.addEventListener('input', (e) => adjustTextareaHeight(e.target));
        chatInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }
    
    // Settings Modal Logic
    if (settingsBtn) settingsBtn.addEventListener('click', () => { settingsModal.style.display = 'flex'; });
    if (closeModalBtn) closeModalBtn.addEventListener('click', () => { settingsModal.style.display = 'none'; });
    window.addEventListener('click', (event) => {
        if (event.target == settingsModal) {
            settingsModal.style.display = "none";
        }
    });

    if (noiseSuppressionToggle) noiseSuppressionToggle.addEventListener('change', (e) => toggleNoiseSuppression(e.target.checked));
    if (videoFilterSelect) videoFilterSelect.addEventListener('change', (e) => applyVideoFilter(e.target.value));
}

// --- WEBRTC & SOCKET.IO EVENT HANDLING --- (No changes below this line, but included for completeness)

socket.on('user-connected', (userId) => {
    console.log(`New user connected: ${userId}`);
    participantCount++;
    updateParticipantCount();
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
    participantCount = Math.max(1, participantCount - 1);
    updateParticipantCount();
    
    if (peers[userId]) {
        peers[userId].close();
        delete peers[userId];
    }
    const videoElement = document.getElementById(userId);
    if (videoElement) {
        videoElement.parentElement.remove();
    }
});

// Chat socket events
socket.on('chat-message', (data) => {
    const messageData = {
        ...data.message,
        sender: 'other'
    };
    addMessageToChat(messageData);
});

// Connection status management
function updateConnectionStatus(status) {
    const connectionDot = document.getElementById('connection-dot');
    const connectionText = document.getElementById('connection-text');
    
    if (connectionDot && connectionText) {
        connectionDot.className = `connection-dot ${status}`;
        
        switch (status) {
            case 'connected':
                connectionText.textContent = 'Connected';
                break;
            case 'connecting':
                connectionText.textContent = 'Connecting...';
                break;
            case 'disconnected':
                connectionText.textContent = 'Disconnected';
                break;
        }
    }
}

function updateParticipantCount() {
    const participantCounter = document.getElementById('participant-counter');
    if (participantCounter) {
        participantCounter.textContent = `${participantCount} participant${participantCount !== 1 ? 's' : ''}`;
    }
}

// Socket connection events
socket.on('connect', () => {
    updateConnectionStatus('connected');
});

socket.on('disconnect', () => {
    updateConnectionStatus('disconnected');
});

socket.on('reconnecting', () => {
    updateConnectionStatus('connecting');
});

// --- WEBRTC HELPER FUNCTIONS ---

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