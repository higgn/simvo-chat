// Simvo Chat - Frontend WebRTC Logic (v2 - Feature Enhanced)

// --- STATE MANAGEMENT ---
let localStream;
let isMicOn = true;
let isVideoOn = true;
let isScreenSharing = false;
let isNoiseSuppressionEnabled = true;
let peers = {};
let dataChannels = {};
let fileReceivers = {};
let transfers = {}; // active transfers: { transferId: { file, aborted, perPeer: { [peerId]: bytesSent } } }
let videoDevices = [];
let audioDevices = [];
let currentVideoDeviceIndex = 0;
let currentAudioDeviceIndex = 0;
let participantCount = 1;
let connectionStatus = 'connected';
let isFullscreen = false;
let recordingState = false;
let networkQuality = 'good';

// --- INITIALIZATION ---
const ROOM_ID = window.location.pathname.substring(1);
/* const socket = io();
 */
const socket = io('https://simvo-chat-server.onrender.com'); 

// Persistent client id so refresh doesn't create a new logical identity client-side
let CLIENT_ID = localStorage.getItem('simvo_client_id');
if (!CLIENT_ID) {
    CLIENT_ID = Math.random().toString(36).substring(2, 12);
    localStorage.setItem('simvo_client_id', CLIENT_ID);
}

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
    // send clientId to let server optionally dedupe persistent clients (server may ignore it)
    socket.emit('join-room', { roomId: ROOM_ID, clientId: CLIENT_ID });
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
        audioDevices = devices.filter(device => device.kind === 'audioinput');
        
        const flipCameraBtn = document.getElementById('flip-camera-btn');
        if (videoDevices.length > 1) {
            flipCameraBtn.style.display = 'flex';
        }
    } catch (error) {
        console.error('Error enumerating devices:', error);
    }
}

// Network Quality Monitoring
function monitorNetworkQuality() {
    for (const peerId in peers) {
        const peerConnection = peers[peerId];
        if (peerConnection) {
            peerConnection.getStats().then(stats => {
                let rtt = 0;
                let packetsLost = 0;
                let packetsReceived = 0;
                
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                        rtt = report.currentRoundTripTime * 1000; // Convert to ms
                    }
                    if (report.type === 'inbound-rtp' && report.mediaType === 'video') {
                        packetsLost = report.packetsLost || 0;
                        packetsReceived = report.packetsReceived || 0;
                    }
                });
                
                const lossRate = packetsReceived > 0 ? (packetsLost / packetsReceived) * 100 : 0;
                
                // Determine quality
                if (rtt < 100 && lossRate < 1) {
                    networkQuality = 'good';
                } else if (rtt < 300 && lossRate < 3) {
                    networkQuality = 'fair';
                } else {
                    networkQuality = 'poor';
                }
                
                updateSignalQuality(networkQuality);
            }).catch(err => console.warn('Stats error:', err));
        }
    }
}

function updateSignalQuality(quality) {
    const signalEl = document.getElementById('signal-quality');
    if (signalEl) {
        signalEl.classList.remove('good', 'fair', 'poor');
        signalEl.classList.add(quality);
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

// Fullscreen functionality
function toggleFullscreen() {
    const roomElement = document.getElementById('room');
    
    if (!isFullscreen) {
        if (roomElement.requestFullscreen) {
            roomElement.requestFullscreen();
        } else if (roomElement.webkitRequestFullscreen) {
            roomElement.webkitRequestFullscreen();
        } else if (roomElement.msRequestFullscreen) {
            roomElement.msRequestFullscreen();
        }
        document.body.classList.add('fullscreen-active');
        isFullscreen = true;
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
        document.body.classList.remove('fullscreen-active');
        isFullscreen = false;
    }
}

// Listen for fullscreen changes
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        document.body.classList.remove('fullscreen-active');
        isFullscreen = false;
    }
});

// Copy room URL to clipboard
function copyRoomURL() {
    const roomURL = window.location.href;
    navigator.clipboard.writeText(roomURL).then(() => {
        // Show temporary notification
        showNotification('Room link copied to clipboard!');
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
}

function showNotification(message) {
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: var(--surface-elevated);
        color: var(--foreground);
        padding: 12px 20px;
        border-radius: 8px;
        border: 1px solid var(--border-subtle);
        z-index: 1000;
        animation: slideIn 0.3s ease;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease forwards';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// --- UTILITY FUNCTIONS ---

async function replaceTrackForPeers(newTrack, kind = 'video') {
    for (const peerId in peers) {
        const peerConnection = peers[peerId];
        if (!peerConnection || !peerConnection.getSenders) continue;
        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === kind);
        if (sender) {
            try {
                await sender.replaceTrack(newTrack);
            } catch (err) {
                console.warn('replaceTrack failed for', peerId, err);
            }
        }
    }
}

function updateAllPeerTracks() {
    if (!localStream) return;
    for (const peerId in peers) {
        const peerConnection = peers[peerId];
        if (!peerConnection || !peerConnection.getSenders) continue;
        localStream.getTracks().forEach(track => {
            const sender = peerConnection.getSenders().find(s => s.track && s.track.kind == track.kind);
            if (sender) {
                try { sender.replaceTrack(track); } catch (err) { console.warn('updateAllPeerTracks replace failed', err); }
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

    // If this is a file message, show file UI with progress
    if (messageData.file) {
        const file = messageData.file;
        messageElement.innerHTML = `
            <div class="file-attach">
                <div class="file-progress" data-transfer-id="${messageData.transferId}">
                    <svg viewBox="0 0 36 36" width="36" height="36">
                        <path class="progress-bg" d="M18 2.0845a15.9155 15.9155 0 1 0 0 31.831" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="3"></path>
                        <path class="progress-bar" d="M18 2.0845a15.9155 15.9155 0 1 0 0 31.831" fill="none" stroke="var(--primary)" stroke-width="3" stroke-dasharray="0 100" stroke-linecap="round"></path>
                    </svg>
                    <div class="progress-text">0%</div>
                </div>
                <div class="file-meta">
                    <div class="file-name">${escapeHtml(file.name)}</div>
                    <div class="file-size">${formatBytes(file.size)}</div>
                </div>
            </div>
            <div class="message-time">${messageData.timestamp}</div>
        `;
    } else {
        messageElement.innerHTML = `
            <div>${escapeHtml(messageData.text || '')}</div>
            <div class="message-time">${messageData.timestamp}</div>
        `;
    }

    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    // If outgoing file message, add cancel control
    if (messageData.file && messageData.sender === 'own') {
        const meta = messageElement.querySelector('.file-meta');
        if (meta) {
            const btn = document.createElement('button');
            btn.className = 'file-cancel-btn';
            btn.textContent = 'Cancel';
            btn.addEventListener('click', () => {
                if (messageData.transferId) cancelTransfer(messageData.transferId);
            });
            meta.appendChild(btn);
            // Add per-peer list for progress
            const perPeer = document.createElement('div');
            perPeer.className = 'per-peer-list';
            perPeer.setAttribute('data-transfer-id', messageData.transferId);
            // populate with current peers (use short id)
            for (const peerId in peers) {
                const item = document.createElement('div');
                item.className = 'peer-item';
                item.setAttribute('data-peer-id', peerId);
                const short = document.createElement('span'); short.className = 'peer-name'; short.textContent = peerId.slice(0,6);
                const prog = document.createElement('span'); prog.className = 'peer-progress'; prog.textContent = '0%';
                item.appendChild(short); item.appendChild(prog);
                perPeer.appendChild(item);
            }
            meta.appendChild(perPeer);
        }
    }
}

// Update an individual peer's progress UI
function updatePerPeerProgress(transferId, peerId, fraction) {
    const list = document.querySelector(`.per-peer-list[data-transfer-id="${transferId}"]`);
    if (!list) return;
    const item = list.querySelector(`.peer-item[data-peer-id="${peerId}"]`);
    if (!item) return;
    const pct = Math.round(fraction * 100);
    const prog = item.querySelector('.peer-progress');
    if (prog) prog.textContent = `${pct}%`;
}

// Helper: escape HTML to prevent injection in chat messages
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":"&#39;"})[c]);
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B','KB','MB','GB','TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Update progress UI for a given transferId (0-1 progress)
function updateChatProgress(transferId, fraction) {
    const el = document.querySelector(`.file-progress[data-transfer-id="${transferId}"]`);
    if (!el) return;
    const pct = Math.round(fraction * 100);
    const path = el.querySelector('.progress-bar');
    const text = el.querySelector('.progress-text');
    if (path) {
        const dash = Math.max(0, Math.min(100, pct));
        path.setAttribute('stroke-dasharray', `${dash} 100`);
    }
    if (text) text.textContent = `${pct}%`;
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
    const fullscreenBtn = document.getElementById('fullscreen-btn');
    const copyLinkBtn = document.getElementById('copy-link-btn');

    // Microphone control with icon states
    if (micBtn) micBtn.addEventListener('click', () => {
        isMicOn = !isMicOn;
        if (localStream && localStream.getAudioTracks().length) {
            localStream.getAudioTracks()[0].enabled = isMicOn;
        }
        updateIconState(micBtn, isMicOn, '.mic-on', '.mic-off');
        micBtn.title = isMicOn ? 'Mute microphone' : 'Unmute microphone';
    });

    // Video control with icon states
    if (videoBtn) videoBtn.addEventListener('click', () => {
        isVideoOn = !isVideoOn;
        if (localStream && localStream.getVideoTracks().length) {
            localStream.getVideoTracks()[0].enabled = isVideoOn;
        }
        updateIconState(videoBtn, isVideoOn, '.video-on', '.video-off');
        videoBtn.title = isVideoOn ? 'Turn off camera' : 'Turn on camera';
    });

    // Other controls
    if (endCallBtn) endCallBtn.addEventListener('click', () => { window.location.href = '/'; });
    if (screenShareBtn) screenShareBtn.addEventListener('click', toggleScreenShare);
    if (flipCameraBtn) flipCameraBtn.addEventListener('click', flipCamera);
    if (fullscreenBtn) fullscreenBtn.addEventListener('click', toggleFullscreen);
    if (copyLinkBtn) copyLinkBtn.addEventListener('click', copyRoomURL);
    
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

    // PiP and file transfer UI wiring
    const pipBtn = document.getElementById('pip-btn');
    const fileInput = document.getElementById('file-input');
    const sendFileBtn = document.getElementById('send-file-btn');
    if (pipBtn) pipBtn.addEventListener('click', togglePictureInPicture);
    if (sendFileBtn && fileInput) {
        sendFileBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) sendFileToPeers(file);
        });
    }

    // Controls collapse / expand
    const controlsToggle = document.getElementById('controls-toggle-btn');
    const controlsBar = document.getElementById('controls');
    if (controlsToggle && controlsBar) {
        controlsToggle.addEventListener('click', () => {
            controlsBar.classList.toggle('collapsed');
            // toggle reduced aria label
            controlsToggle.title = controlsBar.classList.contains('collapsed') ? 'Expand controls' : 'More controls';
        });
    }

    // Make local preview draggable and resizable
    const localContainer = document.getElementById('local-video-container');
    if (localContainer) {
        let isDragging = false;
        let startX = 0, startY = 0, origX = 0, origY = 0;

        const onPointerDown = (e) => {
            // only start drag on primary button / touch
            if (e.button !== undefined && e.button !== 0) return;
            isDragging = true;
            localContainer.setPointerCapture?.(e.pointerId);
            startX = e.clientX;
            startY = e.clientY;
            const rect = localContainer.getBoundingClientRect();
            origX = rect.right - rect.width; // left
            origY = rect.bottom - rect.height; // top
        };

        const onPointerMove = (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            // compute new right/bottom based on dx/dy to keep positioning anchored from bottom-right
            const newRight = Math.max(8, (window.innerWidth - (origX + dx)));
            const newBottom = Math.max(8, (window.innerHeight - (origY + dy)));
            localContainer.style.right = `${newRight}px`;
            localContainer.style.bottom = `${newBottom}px`;
        };

        const onPointerUp = (e) => {
            if (!isDragging) return;
            isDragging = false;
            try { localContainer.releasePointerCapture?.(e.pointerId); } catch(e){}
        };

        // Use pointer events for unified mouse/touch support
        localContainer.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);

        // Resizable - allow user to drag the corner via native resize; add visual class when resizing
        let resizeObserver = null;
        try {
            const ro = new ResizeObserver(() => {
                localContainer.classList.add('resizing');
                clearTimeout(localContainer.__resizeTimeout);
                localContainer.__resizeTimeout = setTimeout(() => localContainer.classList.remove('resizing'), 250);
            });
            ro.observe(localContainer);
            resizeObserver = ro;
        } catch (e) {
            // ResizeObserver may not be supported in older browsers; ignore gracefully
        }
    }

    // Real-time network quality monitoring
    const signalEl = document.getElementById('signal-quality');
    if (signalEl) {
        // Start monitoring network quality every 5 seconds
        setInterval(monitorNetworkQuality, 5000);
        // Initialize with good quality
        updateSignalQuality('good');
    }

    // Gestures: double-tap to expand, long-press to minimize (touch-friendly)
    if (localContainer) {
        let lastTap = 0;
        let longPressTimer = null;

        const onTapStart = (e) => {
            const now = Date.now();
            if (now - lastTap < 300) {
                // double-tap
                localContainer.classList.toggle('local-expanded');
                // ensure minimized is removed
                localContainer.classList.remove('local-minimized');
            }
            lastTap = now;

            // start long-press timer (600ms)
            longPressTimer = setTimeout(() => {
                localContainer.classList.add('local-minimized');
                localContainer.classList.remove('local-expanded');
            }, 600);
        };

        const onTapEnd = (e) => {
            if (longPressTimer) clearTimeout(longPressTimer);
        };

        localContainer.addEventListener('pointerdown', onTapStart);
        localContainer.addEventListener('pointerup', onTapEnd);
        localContainer.addEventListener('pointercancel', onTapEnd);
    }
}

// --- WEBRTC & SOCKET.IO EVENT HANDLING --- (No changes below this line, but included for completeness)

// CORRECTED HANDLER #1: For when you first join a room
socket.on('all-users', (users) => {
    console.log('Received list of all users in room:', users);
    users.forEach(userId => {
        // --- START OF FIX ---
        // Only the client with the "greater" ID will initiate the call to prevent glare.
        if (socket.id > userId) {
            callUser(userId);
        }
        // --- END OF FIX ---
    });
});

// CORRECTED HANDLER #2: For when a new user joins after you
socket.on('user-connected', (userId) => {
    console.log(`New user connected: ${userId}`);
    if (userId === socket.id) return;
    
    // --- START OF FIX ---
    // The same logic applies here. The existing client with the "greater" ID calls the new one.
    if (socket.id > userId) {
        if (!peers[userId]) {
            participantCount++;
            updateParticipantCount();
            callUser(userId);
        }
    }
    // --- END OF FIX ---
});


/// CORRECTED HANDLER #3: Receiving an offer
socket.on('offer', async (payload) => {
    console.log(`Received offer from ${payload.caller}`);
    
    // --- START OF FIX (Robustness improvement) ---
    // Get or create the peer connection to avoid accidentally overwriting an existing one.
    let peerConnection = peers[payload.caller];
    if (!peerConnection) {
        peerConnection = createPeerConnection(payload.caller);
    }
    // --- END OF FIX ---
    
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

    // If localStream isn't ready yet, skip adding tracks now - updateAllPeerTracks will add them later
    if (localStream && localStream.getTracks) {
        localStream.getTracks().forEach(track => {
            try { peerConnection.addTrack(track, localStream); } catch (err) { console.warn('addTrack failed', err); }
        });
    }

    peerConnection.ontrack = (event) => {
    addRemoteStream(userId, event.streams[0]);
    };

    // Handle inbound data channels (file transfer / messages)
    peerConnection.ondatachannel = (event) => {
        try {
            setupDataChannel(event.channel, userId);
        } catch (e) {
            console.warn('ondatachannel handler error', e);
        }
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

    // Create a reliable data channel for file transfer / messages
    try {
        const dc = peerConnection.createDataChannel('simvo-data');
        setupDataChannel(dc, userId);
    } catch (e) {
        console.warn('Failed to create data channel', e);
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('offer', { target: userId, signal: offer, caller: socket.id });
};

// Setup handlers for an RTCDataChannel
function setupDataChannel(channel, userId) {
    dataChannels[userId] = channel;

    channel.onopen = () => {
        console.log('Data channel open for', userId);
    };

    channel.onmessage = async (event) => {
        // String messages are control/meta; binary are file chunks
        if (typeof event.data === 'string') {
            try {
                const msg = JSON.parse(event.data);
                if (msg.type === 'file-meta') {
                    const transferId = msg.transferId || `${userId}-${Date.now()}`;
                    fileReceivers[userId] = { meta: msg, buffers: [], received: 0, transferId };
                    // Render incoming file message in chat
                    addMessageToChat({ file: { name: msg.name, size: msg.size }, timestamp: new Date().toLocaleTimeString(), sender: 'other', transferId });
                    showNotification(`Incoming file: ${msg.name} from ${userId}`);
                } else if (msg.type === 'file-end') {
                    // assemble
                    const receiver = fileReceivers[userId];
                    if (receiver) {
                        const blob = new Blob(receiver.buffers);
                        const url = URL.createObjectURL(blob);
                        // replace progress UI with download link
                        const sel = `.file-progress[data-transfer-id="${receiver.transferId}"]`;
                        const progEl = document.querySelector(sel);
                        if (progEl) {
                            const metaEl = progEl.parentElement.querySelector('.file-meta');
                            // Thumbnail for images
                            if (receiver.meta && receiver.meta.type && receiver.meta.type.startsWith('image/')) {
                                const img = document.createElement('img');
                                img.className = 'file-thumbnail';
                                img.src = url;
                                metaEl.insertBefore(img, metaEl.firstChild);
                            }

                            const actions = document.createElement('div'); actions.className = 'file-actions';
                            const openBtn = document.createElement('button'); openBtn.className = 'file-action-btn primary'; openBtn.textContent = 'Open';
                            openBtn.addEventListener('click', () => { window.open(url, '_blank'); });
                            const saveBtn = document.createElement('a'); saveBtn.className = 'file-action-btn'; saveBtn.textContent = 'Save'; saveBtn.href = url; saveBtn.download = receiver.meta.name || 'download';
                            const removeBtn = document.createElement('button'); removeBtn.className = 'file-action-btn'; removeBtn.textContent = 'Remove';
                            removeBtn.addEventListener('click', () => {
                                try { URL.revokeObjectURL(url); } catch(e){}
                                const parent = metaEl.parentElement;
                                parent && parent.remove();
                            });
                            actions.appendChild(openBtn); actions.appendChild(saveBtn); actions.appendChild(removeBtn);
                            metaEl.appendChild(actions);
                            progEl.remove();
                        }
                        showNotification(`File received: ${receiver.meta.name}`);
                        // Verify checksum if provided
                        if (receiver.meta && receiver.meta.checksum) {
                            try {
                                const ab = await blob.arrayBuffer();
                                const digest = await crypto.subtle.digest('SHA-256', ab);
                                const hashArray = Array.from(new Uint8Array(digest));
                                const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                                if (hashHex !== receiver.meta.checksum) {
                                    showNotification('Checksum mismatch for received file');
                                    const note = document.createElement('div'); note.textContent = 'Checksum mismatch';
                                    const metaEl = document.querySelector(sel)?.parentElement.querySelector('.file-meta');
                                    if (metaEl) metaEl.appendChild(note);
                                            try { channel.send(JSON.stringify({ type: 'file-checksum-mismatch', transferId: receiver.transferId })); } catch(e){}
                                } else {
                                    const note = document.createElement('div'); note.textContent = 'Verified ✓';
                                    const metaEl = document.querySelector(sel)?.parentElement.querySelector('.file-meta');
                                    if (metaEl) metaEl.appendChild(note);
                                }
                            } catch (e) {
                                console.warn('Checksum verify failed', e);
                            }
                        }
                        delete fileReceivers[userId];
                    }
                } else if (msg.type === 'file-cancel') {
                    // sender canceled
                    const receiver = fileReceivers[userId];
                    if (receiver) {
                        const sel = `.file-progress[data-transfer-id="${receiver.transferId}"]`;
                        const progEl = document.querySelector(sel);
                        if (progEl) {
                            const cancelNote = document.createElement('div'); cancelNote.textContent = 'Canceled';
                            progEl.parentElement.querySelector('.file-meta').appendChild(cancelNote);
                            progEl.remove();
                        }
                        delete fileReceivers[userId];
                    }
                    showNotification('Transfer canceled');
                } else if (msg.type === 'file-checksum-mismatch') {
                    showNotification('Warning: file checksum mismatch reported by sender');
                }
            } catch (e) {
                console.warn('Failed to parse data message', e);
            }
        } else {
            // binary chunk
            const receiver = fileReceivers[userId];
            if (receiver) {
                receiver.buffers.push(event.data);
                const chunkSize = event.data.byteLength || event.data.size || 0;
                receiver.received += chunkSize;
                // update chat UI progress
                if (receiver.meta && receiver.meta.size) {
                    const frac = Math.min(1, receiver.received / receiver.meta.size);
                    updateChatProgress(receiver.transferId, frac);
                }
            }
        }
    };

    channel.onerror = (e) => console.warn('DataChannel error', e);
    channel.onclose = () => console.log('Data channel closed', userId);
}

// Wait for RTCDataChannel bufferedAmount to drop below threshold (bytes)
function waitForBufferedAmount(dc, threshold = 65536) {
    return new Promise((resolve) => {
        if (!dc || dc.bufferedAmount < threshold) return resolve();
        const onLow = () => {
            if (dc.bufferedAmount < threshold) {
                try { dc.removeEventListener('bufferedamountlow', onLow); } catch(e){}
                resolve();
            }
        };
        try { dc.addEventListener('bufferedamountlow', onLow); } catch(e){}
        const iv = setInterval(() => {
            if (dc.bufferedAmount < threshold) {
                clearInterval(iv);
                try { dc.removeEventListener('bufferedamountlow', onLow); } catch(e){}
                resolve();
            }
        }, 50);
    });
}

function cancelTransfer(transferId) {
    const t = transfers[transferId];
    if (!t) return;
    t.aborted = true;
    // Notify peers
    for (const peerId in dataChannels) {
        const dc = dataChannels[peerId];
        if (dc && dc.readyState === 'open') {
            try { dc.send(JSON.stringify({ type: 'file-cancel', transferId })); } catch (e) {}
        }
    }
    // Update UI
    const sel = `.file-progress[data-transfer-id="${transferId}"]`;
    const progEl = document.querySelector(sel);
    if (progEl) {
        const note = document.createElement('div'); note.textContent = 'Canceled';
        const meta = progEl.parentElement.querySelector('.file-meta');
        if (meta) meta.appendChild(note);
        progEl.remove();
    }
    showNotification('Transfer canceled');
}

async function sendFileToPeers(file) {
    if (!file) return;
    const CHUNK_SIZE = 16384; // 16KB
    const HIGH_WATER = 262144; // 256KB
    const LOW_WATER = 65536; // 64KB

    // generate a transfer id
    const transferId = `tx-${Date.now()}-${Math.random().toString(36).substr(2,6)}`;
    // register transfer
    transfers[transferId] = { file, aborted: false, perPeer: {} };
    // Render outgoing file message in chat
    addMessageToChat({ file: { name: file.name, size: file.size }, timestamp: new Date().toLocaleTimeString(), sender: 'own', transferId });

    // Compute checksum (SHA-256) if possible
    let checksum = null;
    try {
        const abAll = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', abAll);
        checksum = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) {
        console.warn('Checksum compute failed', e);
    }

    // Send meta first to all open channels (include checksum if computed)
    for (const peerId in dataChannels) {
        const dc = dataChannels[peerId];
        if (dc && dc.readyState === 'open') {
            try { dc.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, transferId, checksum })); } catch(e) { console.warn('meta send failed', e); }
        }
    }

    const stream = file.stream ? file.stream() : null;
    if (stream) {
        // modern browsers: use stream reader
        const reader = stream.getReader();
        let sent = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            sent += value.byteLength || value.length || 0;
            for (const peerId in dataChannels) {
                const dc = dataChannels[peerId];
                if (dc && dc.readyState === 'open') {
                    try {
                        if (transfers[transferId] && transfers[transferId].aborted) break;
                        dc.send(value);
                            const bytesSent = (transfers[transferId].perPeer[peerId] || 0) + (value.byteLength || value.length || 0);
                            transfers[transferId].perPeer[peerId] = bytesSent;
                            updatePerPeerProgress(transferId, peerId, bytesSent / file.size);
                        if (dc.bufferedAmount > HIGH_WATER) await waitForBufferedAmount(dc, LOW_WATER);
                    } catch (e) { console.warn('DC send chunk failed', e); }
                }
            }
            const frac = Math.min(1, sent / file.size);
            updateChatProgress(transferId, frac);
            if (transfers[transferId] && transfers[transferId].aborted) break;
        }
    } else {
        // Fallback: use FileReader chunks
        let offset = 0;
        let sent = 0;
        while (offset < file.size) {
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            const arrayBuffer = await slice.arrayBuffer();
            for (const peerId in dataChannels) {
                const dc = dataChannels[peerId];
                if (dc && dc.readyState === 'open') {
                    try {
                        if (transfers[transferId] && transfers[transferId].aborted) break;
                        dc.send(arrayBuffer);
                            const bytesSent = (transfers[transferId].perPeer[peerId] || 0) + (arrayBuffer.byteLength || arrayBuffer.length || 0);
                            transfers[transferId].perPeer[peerId] = bytesSent;
                            updatePerPeerProgress(transferId, peerId, bytesSent / file.size);
                        if (dc.bufferedAmount > HIGH_WATER) await waitForBufferedAmount(dc, LOW_WATER);
                    } catch (e) { console.warn('DC send chunk failed', e); }
                }
            }
            offset += CHUNK_SIZE;
            sent += arrayBuffer.byteLength || arrayBuffer.length || 0;
            const frac = Math.min(1, sent / file.size);
            updateChatProgress(transferId, frac);
            if (transfers[transferId] && transfers[transferId].aborted) break;
        }
    }

    // If aborted, notify and cleanup
    if (transfers[transferId] && transfers[transferId].aborted) {
        for (const peerId in dataChannels) {
            const dc = dataChannels[peerId];
            if (dc && dc.readyState === 'open') {
                try { dc.send(JSON.stringify({ type: 'file-cancel', transferId })); } catch(e){}
            }
        }
        showNotification(`File transfer canceled: ${file.name}`);
        delete transfers[transferId];
        return;
    }

    // notify peers that file is complete
    for (const peerId in dataChannels) {
        const dc = dataChannels[peerId];
        if (dc && dc.readyState === 'open') {
            try { dc.send(JSON.stringify({ type: 'file-end', transferId })); } catch(e) { console.warn('end notify failed', e); }
        }
    }

    showNotification(`File sent: ${file.name}`);
    delete transfers[transferId];
}

// Focused video for PiP / UI actions
let focusedVideoElement = null;
function setFocusedVideo(el) {
    focusedVideoElement = el;
}

async function togglePictureInPicture() {
    const video = focusedVideoElement || document.getElementById('local-video');
    if (!video) return;

    try {
        if (document.pictureInPictureElement) {
            await document.exitPictureInPicture();
        } else {
            if (video.requestPictureInPicture) {
                await video.requestPictureInPicture();
            } else {
                showNotification('Picture-in-Picture not supported in this browser');
            }
        }
    } catch (e) {
        console.warn('PiP toggle failed', e);
    }
}

function toggleElementFullscreen(el) {
    if (!el) return;
    const container = el.closest('.video-container') || el;
    if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
    } else {
        if (container.requestFullscreen) container.requestFullscreen();
    }
}

const addRemoteStream = (userId, stream) => {
    if (document.getElementById(userId)) return;

    const videoContainer = document.createElement('div');
    videoContainer.classList.add('video-container');
    
    const remoteVideo = document.createElement('video');
    remoteVideo.id = userId;
    remoteVideo.srcObject = stream;
    remoteVideo.autoplay = true;
    remoteVideo.playsInline = true;

    // Attempt to start playback; many browsers block autoplay without user interaction
    remoteVideo.addEventListener('loadedmetadata', () => {
        const p = remoteVideo.play();
        if (p && p.catch) p.catch(err => { /* ignore autoplay errors until user interacts */ });
    });

    const nameTag = document.createElement('span');
    nameTag.classList.add('name-tag');
    nameTag.innerText = 'Peer';

    videoContainer.appendChild(remoteVideo);
    videoContainer.appendChild(nameTag);
    videoGrid.appendChild(videoContainer);

    // Allow double-click to fullscreen the specific peer video and single click to focus for PiP
    remoteVideo.addEventListener('dblclick', () => toggleElementFullscreen(remoteVideo));
    remoteVideo.addEventListener('click', () => setFocusedVideo(remoteVideo));
};

// --- RUN ---
handlePath();