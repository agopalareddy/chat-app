const http = require("http");
const fs = require("fs");
const path = require("path");

// Configuration
const PORT = process.env.PORT || 3456;
const MAX_MESSAGE_LENGTH = parseInt(process.env.MAX_MESSAGE_LENGTH) || 2000;
const MAX_NICKNAME_LENGTH = 30;
const MESSAGE_HISTORY_LIMIT = 100;
const KICK_DURATION_MIN = 1;
const KICK_DURATION_MAX = 1440;
const TYPING_TIMEOUT_MS = 5000;
const MESSAGE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MESSAGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Rate limiting
const RATE_LIMITS = {
    messages: { max: 5, window: 1000 },
    roomCreate: { max: 10, window: 60000 },
    privateMessages: { max: 20, window: 60000 }
};

// HTML escape for XSS prevention
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Generate unique ID
function generateId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Validate nickname
function isValidNickname(nickname) {
    if (typeof nickname !== 'string') return false;
    const trimmed = nickname.trim();
    if (trimmed.length < 1 || trimmed.length > MAX_NICKNAME_LENGTH) return false;
    if (/[<>]/.test(trimmed)) return false;
    return /^[a-zA-Z0-9 _-]+$/.test(trimmed);
}

// Content-Type map
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json'
};

// HTTP Server
const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    // Health check endpoint
    if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            uptime: process.uptime(),
            rooms: state.rooms.length,
            users: state.socketsToNicks.size
        }));
        return;
    }

    // Serve static files
    if (url === '/style.css' || url === '/client.js') {
        const filePath = url.substring(1);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404);
                return res.end('File not found');
            }
            const ext = path.extname(filePath);
            res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
            res.end(data);
        });
        return;
    }

    // Serve client.html
    if (url === '/' || url === '/client.html') {
        fs.readFile('client.html', (err, data) => {
            if (err) {
                res.writeHead(500);
                return res.end('Server error');
            }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
        return;
    }

    // 404 for everything else
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
});

const io = require("socket.io")(http, { wsEngine: 'ws' }).listen(server);
server.listen(PORT, () => {
    console.log(`Chat server running on port ${PORT}`);
});

// State management
const state = {
    rooms: ["Lobby"],
    usersByRoom: {},
    socketsToNicks: new Map(),
    nicksToSockets: new Map(),
    roomPasswords: new Map(),
    roomCreators: new Map(),
    bannedUsers: new Map(),      // room → Set of nicknames
    kickedUsers: new Map(),      // room → Map(nickname → expirationTime)
    userRoomHistory: new Map(),
    unreadCounts: new Map(),     // `${nickname}_${otherUser}` → count
    messages: {
        rooms: new Map(),
        private: new Map()
    }
};

// Rate limiter per socket
const rateLimiters = new Map();

function checkRateLimit(socketId, action) {
    const limit = RATE_LIMITS[action];
    if (!limit) return true;

    const key = `${socketId}_${action}`;
    if (!rateLimiters.has(key)) rateLimiters.set(key, []);
    const timestamps = rateLimiters.get(key);
    const now = Date.now();

    while (timestamps.length > 0 && now - timestamps[0] > limit.window) {
        timestamps.shift();
    }

    if (timestamps.length >= limit.max) return false;
    timestamps.push(now);
    return true;
}

// Helper functions
const helpers = {
    getRoomList: () => state.rooms.map(r => ({
        name: r,
        hasPassword: state.roomPasswords.has(r) && state.roomPasswords.get(r) !== '',
        owner: state.roomCreators.get(r) || null
    })),

    isUserKicked: (nickname, room) => {
        const roomKicks = state.kickedUsers.get(room);
        if (!roomKicks?.has(nickname)) return false;
        const expirationTime = roomKicks.get(nickname);
        if (Date.now() >= expirationTime) {
            roomKicks.delete(nickname);
            return false;
        }
        return Math.ceil((expirationTime - Date.now()) / (60 * 1000));
    },

    getPrivateChatId: (user1, user2) => [user1, user2].sort().join('_'),

    addMessage: (type, id, message) => {
        if (!state.messages[type].has(id)) {
            state.messages[type].set(id, []);
        }
        const messages = state.messages[type].get(id);
        messages.push(message);
        if (messages.length > MESSAGE_HISTORY_LIMIT) messages.shift();
    },

    deleteMessage: (type, id, messageId) => {
        if (state.messages[type].has(id)) {
            const messages = state.messages[type].get(id);
            state.messages[type].set(id, messages.filter(m => m.messageId !== messageId));
        }
    },

    cleanupMessages: () => {
        const dayAgo = Date.now() - MESSAGE_MAX_AGE_MS;
        ['rooms', 'private'].forEach(type => {
            for (const [id, messages] of state.messages[type].entries()) {
                state.messages[type].set(id, messages.filter(m => m.timestamp > dayAgo));
            }
        });
    }
};

setInterval(helpers.cleanupMessages, MESSAGE_CLEANUP_INTERVAL_MS);

io.sockets.on("connection", socket => {
    const emitRoomUpdate = () => io.sockets.emit("update_rooms", helpers.getRoomList());
    const getUserNickname = () => state.socketsToNicks.get(socket.id);

    const updateRoomUsers = (room) => {
        if (!state.usersByRoom[room]) return;

        const bannedUsers = state.bannedUsers.has(room)
            ? Array.from(state.bannedUsers.get(room))
            : [];

        const kickedUsers = {};
        if (state.kickedUsers.has(room)) {
            for (const [nickname, expirationTime] of state.kickedUsers.get(room).entries()) {
                if (Date.now() < expirationTime) {
                    kickedUsers[nickname] = expirationTime;
                }
            }
        }

        io.sockets.in(room).emit("update_users", {
            users: state.usersByRoom[room].map(id => state.socketsToNicks.get(id)).filter(Boolean),
            roomOwner: state.roomCreators.get(room),
            bannedUsers,
            kickedUsers
        });
    };

    const redirectToLobby = (targetSocket) => {
        targetSocket.emit('force_join', { room: 'Lobby' });
    };

    // ----- NICKNAME -----
    socket.on('set_nickname', nickname => {
        const trimmed = (nickname || '').trim();

        if (!isValidNickname(trimmed)) {
            return socket.emit('error_message', {
                message: 'Invalid nickname. Use 1-30 alphanumeric characters, spaces, underscores, or hyphens.'
            });
        }

        // Check for duplicate nickname (different socket)
        if (state.nicksToSockets.has(trimmed) && state.nicksToSockets.get(trimmed) !== socket.id) {
            return socket.emit('error_message', {
                message: 'This nickname is already taken. Please choose another.'
            });
        }

        // Store old nickname for disconnect cleanup
        const oldNickname = state.socketsToNicks.get(socket.id);

        state.socketsToNicks.set(socket.id, trimmed);
        state.nicksToSockets.set(trimmed, socket.id);

        // Remove old nickname mapping if it was set
        if (oldNickname && oldNickname !== trimmed && state.nicksToSockets.get(oldNickname) === socket.id) {
            state.nicksToSockets.delete(oldNickname);
        }

        // Broadcast online status
        io.sockets.emit('user_online', { nickname: trimmed, online: true });

        // Get private chat history
        const userChats = Array.from(state.messages.private.entries())
            .filter(([chatId, messages]) => {
                const [user1, user2] = chatId.split('_');
                return (user1 === trimmed || user2 === trimmed) &&
                    messages.some(m => (Date.now() - m.timestamp) < MESSAGE_MAX_AGE_MS);
            })
            .map(([chatId, messages]) => ({
                otherUser: chatId.split('_').find(u => u !== trimmed),
                messages
            }));

        socket.emit("nickname_set", { privateChats: userChats });
    });

    // ----- MESSAGES -----
    socket.on('message_to_server', data => {
        const nickname = getUserNickname();
        if (!nickname) return;

        if (!checkRateLimit(socket.id, 'messages')) {
            return socket.emit('error_message', { message: 'You are sending messages too fast. Please slow down.' });
        }

        const msg = (data.message || '').trim();
        if (!msg || msg.length > MAX_MESSAGE_LENGTH) {
            return socket.emit('error_message', { message: 'Message must be between 1 and ' + MAX_MESSAGE_LENGTH + ' characters.' });
        }

        const timestamp = Date.now();
        const messageId = generateId(`${nickname}`);
        const messageData = {
            type: 'room',
            from: nickname,
            message: msg,
            timestamp,
            formattedTime: new Date(timestamp).toLocaleTimeString(),
            messageId,
            replyTo: data.replyTo || null
        };

        helpers.addMessage('rooms', data.room, messageData);
        io.sockets.in(data.room).emit("message_to_client", {
            message: msg,
            messageId,
            from: nickname,
            formattedTime: messageData.formattedTime,
            replyTo: data.replyTo || null
        });
    });

    // ----- ROOM MANAGEMENT -----
    socket.on('create_room', data => {
        const { room, password } = data;
        const trimmed = (room || '').trim();

        if (!trimmed || state.rooms.includes(trimmed)) {
            return socket.emit('error_message', { message: 'Invalid or duplicate room name' });
        }

        if (!checkRateLimit(socket.id, 'roomCreate')) {
            return socket.emit('error_message', { message: 'Too many room creations. Please wait.' });
        }

        const nickname = getUserNickname();
        if (password?.trim()) state.roomPasswords.set(trimmed, password);
        state.roomCreators.set(trimmed, nickname);
        state.rooms.push(trimmed);
        emitRoomUpdate();
    });

    socket.on('join_room', data => {
        const { room, password } = data;
        const nickname = getUserNickname();
        if (!nickname) return;

        const isRoomOwner = state.roomCreators.get(room) === nickname;

        // Check ban (by nickname now)
        if (state.bannedUsers.has(room) && state.bannedUsers.get(room).has(nickname) && !isRoomOwner) {
            return socket.emit('error_message', { message: 'You are banned from this room' });
        }

        // Check kick
        const kickRemaining = helpers.isUserKicked(nickname, room);
        if (kickRemaining && !isRoomOwner) {
            return socket.emit('error_message', { message: `You are kicked from this room for ${kickRemaining} more minutes` });
        }

        // Check password
        if (!isRoomOwner && state.roomPasswords.has(room) && state.roomPasswords.get(room) !== '' && state.roomPasswords.get(room) !== password) {
            return socket.emit('error_message', { message: 'Incorrect password' });
        }

        // If already in this room, just resend history
        if (socket.currentRoom === room) {
            socket.emit("join_room_success", {
                room,
                messageHistory: state.messages.rooms.get(room) || []
            });
            return;
        }

        // Leave current room
        if (socket.currentRoom) {
            socket.leave(socket.currentRoom);
            if (state.usersByRoom[socket.currentRoom]) {
                state.usersByRoom[socket.currentRoom] = state.usersByRoom[socket.currentRoom]
                    .filter(id => id !== socket.id);
                updateRoomUsers(socket.currentRoom);
            }
        }

        // Join new room
        socket.join(room);
        socket.currentRoom = room;
        if (!state.usersByRoom[room]) {
            state.usersByRoom[room] = [];
        }
        state.usersByRoom[room].push(socket.id);

        // Track room history for first-join detection
        if (!state.userRoomHistory.has(room)) {
            state.userRoomHistory.set(room, new Set());
        }
        const isFirstJoin = !state.userRoomHistory.get(room).has(nickname);
        state.userRoomHistory.get(room).add(nickname);

        socket.emit("join_room_success", {
            room,
            messageHistory: state.messages.rooms.get(room) || []
        });

        if (isFirstJoin) {
            io.sockets.in(room).emit("message_to_client", {
                message: `${nickname} has joined the room`,
                messageId: generateId('sys'),
                from: 'System',
                formattedTime: new Date().toLocaleTimeString(),
                type: 'system'
            });
        }

        emitRoomUpdate();
        updateRoomUsers(room);
    });

    socket.on('delete_room', data => {
        const { room } = data;
        if (room !== "Lobby" && state.roomCreators.get(room) === getUserNickname()) {
            state.rooms = state.rooms.filter(r => r !== room);
            delete state.usersByRoom[room];
            state.roomPasswords.delete(room);
            state.roomCreators.delete(room);
            state.bannedUsers.delete(room);
            state.kickedUsers.delete(room);
            state.messages.rooms.delete(room);

            io.sockets.in(room).emit("room_deleted", { room });
            const roomSockets = io.sockets.adapter.rooms.get(room);
            if (roomSockets) {
                roomSockets.forEach(socketId => {
                    const sock = io.sockets.sockets.get(socketId);
                    if (sock) {
                        sock.leave(room);
                        sock.currentRoom = null;
                        sock.emit('force_join', { room: 'Lobby' });
                    }
                });
            }
            emitRoomUpdate();
        }
    });

    // ----- KICK / BAN -----
    socket.on('kick_user', data => {
        const { userId, room, duration } = data;
        const roomOwner = state.roomCreators.get(room);
        const kickerNickname = getUserNickname();

        if (roomOwner !== kickerNickname || !duration || duration < KICK_DURATION_MIN || duration > KICK_DURATION_MAX) {
            return socket.emit('error_message', { message: 'Invalid kick request' });
        }

        const userSocketId = state.nicksToSockets.get(userId);
        if (!userSocketId || userId === roomOwner) {
            return socket.emit('error_message', { message: 'Cannot kick this user' });
        }

        if (!state.kickedUsers.has(room)) {
            state.kickedUsers.set(room, new Map());
        }
        const expirationTime = Date.now() + (duration * 60 * 1000);
        state.kickedUsers.get(room).set(userId, expirationTime);

        const kickedSocket = io.sockets.sockets.get(userSocketId);
        if (kickedSocket) {
            kickedSocket.leave(room);
            if (kickedSocket.currentRoom === room) {
                kickedSocket.currentRoom = null;
            }

            if (state.usersByRoom[room]) {
                state.usersByRoom[room] = state.usersByRoom[room].filter(id => id !== userSocketId);
                updateRoomUsers(room);
            }

            kickedSocket.emit('kicked', { room, duration, expiration: expirationTime });
            redirectToLobby(kickedSocket);

            io.sockets.in(room).emit('message_to_client', {
                message: `${userId} has been kicked for ${duration} minutes`,
                messageId: generateId('sys'),
                from: 'System',
                formattedTime: new Date().toLocaleTimeString(),
                type: 'system'
            });
        }
    });

    socket.on('ban_user', data => {
        const { userId, room } = data;
        const roomOwner = state.roomCreators.get(room);
        const bannerNickname = getUserNickname();

        if (roomOwner !== bannerNickname) {
            return socket.emit('error_message', { message: 'Only room owner can ban users' });
        }

        if (!userId || userId === roomOwner) {
            return socket.emit('error_message', { message: 'Cannot ban this user' });
        }

        // Ban by nickname
        if (!state.bannedUsers.has(room)) {
            state.bannedUsers.set(room, new Set());
        }
        state.bannedUsers.get(room).add(userId);

        // Remove from room
        const userSocketId = state.nicksToSockets.get(userId);
        const bannedSocket = userSocketId ? io.sockets.sockets.get(userSocketId) : null;

        if (bannedSocket) {
            bannedSocket.leave(room);
            if (bannedSocket.currentRoom === room) {
                bannedSocket.currentRoom = null;
                bannedSocket.emit('banned', { room, message: `You have been banned from ${room}` });
            }

            if (state.usersByRoom[room]) {
                state.usersByRoom[room] = state.usersByRoom[room].filter(id => id !== userSocketId);
                updateRoomUsers(room);
            }

            redirectToLobby(bannedSocket);
        }

        io.sockets.in(room).emit('message_to_client', {
            message: `${userId} has been banned from the room`,
            messageId: generateId('sys'),
            from: 'System',
            formattedTime: new Date().toLocaleTimeString(),
            type: 'system'
        });
    });

    socket.on('unban_user', data => {
        const { userId, room } = data;
        if (state.roomCreators.get(room) === getUserNickname()) {
            if (state.bannedUsers.has(room)) {
                state.bannedUsers.get(room).delete(userId);
                if (state.bannedUsers.get(room).size === 0) {
                    state.bannedUsers.delete(room);
                }
                io.sockets.in(room).emit('message_to_client', {
                    message: `${userId} has been unbanned`,
                    messageId: generateId('sys'),
                    from: 'System',
                    formattedTime: new Date().toLocaleTimeString(),
                    type: 'system'
                });
                updateRoomUsers(room);
            }
        }
    });

    socket.on('unkick_user', data => {
        const { userId, room } = data;
        if (state.roomCreators.get(room) === getUserNickname()) {
            if (state.kickedUsers.has(room)) {
                state.kickedUsers.get(room).delete(userId);
                if (state.kickedUsers.get(room).size === 0) {
                    state.kickedUsers.delete(room);
                }
                io.sockets.in(room).emit('message_to_client', {
                    message: `${userId} has been unkicked`,
                    messageId: generateId('sys'),
                    from: 'System',
                    formattedTime: new Date().toLocaleTimeString(),
                    type: 'system'
                });
                updateRoomUsers(room);
            }
        }
    });

    // ----- PRIVATE MESSAGING -----
    socket.on('private_message', data => {
        const { to, message, replyTo } = data;
        const fromNick = getUserNickname();
        if (!fromNick) return;

        if (!checkRateLimit(socket.id, 'privateMessages')) {
            return socket.emit('error_message', { message: 'Sending private messages too fast.' });
        }

        const msg = (message || '').trim();
        if (!msg || msg.length > MAX_MESSAGE_LENGTH) {
            return socket.emit('error_message', { message: 'Message must be 1-' + MAX_MESSAGE_LENGTH + ' characters.' });
        }

        const toSocketId = state.nicksToSockets.get(to);
        if (!toSocketId) {
            return socket.emit('error_message', { message: 'User not found or offline' });
        }

        const chatId = helpers.getPrivateChatId(fromNick, to);
        const timestamp = Date.now();
        const messageId = generateId(`${fromNick}`);
        const messageData = {
            type: 'private',
            from: fromNick,
            to,
            message: msg,
            timestamp,
            messageId,
            formattedTime: new Date(timestamp).toLocaleTimeString(),
            replyTo: replyTo || null
        };

        helpers.addMessage('private', chatId, messageData);

        [toSocketId, socket.id].forEach(id =>
            io.to(id).emit('private_message', messageData)
        );

        // Track unread count for recipient
        const unreadKey = `${to}_${fromNick}`;
        if (!state.unreadCounts.has(unreadKey)) {
            state.unreadCounts.set(unreadKey, 0);
        }
        state.unreadCounts.set(unreadKey, state.unreadCounts.get(unreadKey) + 1);
        io.to(toSocketId).emit('unread_count', {
            otherUser: fromNick,
            count: state.unreadCounts.get(unreadKey)
        });
    });

    socket.on('delete_message', data => {
        const { messageId, room, type, otherUser } = data;
        const nickname = getUserNickname();
        if (!nickname) return;

        if (type === 'private') {
            const chatId = helpers.getPrivateChatId(nickname, otherUser);
            const messages = state.messages.private.get(chatId) || [];
            const message = messages.find(m => m.messageId === messageId);

            if (message && message.from === nickname) {
                helpers.deleteMessage('private', chatId, messageId);
                [state.nicksToSockets.get(otherUser), socket.id].forEach(id => {
                    if (id) io.to(id).emit('message_deleted', { messageId, type: 'private', chatId });
                });
            } else {
                socket.emit('error_message', { message: 'You can only delete your own messages' });
            }
        } else {
            const messages = state.messages.rooms.get(room) || [];
            const message = messages.find(m => m.messageId === messageId);

            if (message && (message.from === nickname || state.roomCreators.get(room) === nickname)) {
                helpers.deleteMessage('rooms', room, messageId);
                io.sockets.in(room).emit('message_deleted', { messageId, type: 'room' });
            } else {
                socket.emit('error_message', { message: 'You do not have permission to delete this message' });
            }
        }
    });

    socket.on('open_private_chat', otherUser => {
        const nickname = getUserNickname();
        if (!nickname) return;

        const chatId = helpers.getPrivateChatId(nickname, otherUser);
        socket.emit('private_chat_history', {
            otherUser,
            messages: state.messages.private.get(chatId) || []
        });

        // Reset unread count
        const unreadKey = `${nickname}_${otherUser}`;
        if (state.unreadCounts.has(unreadKey)) {
            state.unreadCounts.set(unreadKey, 0);
            socket.emit('unread_count', { otherUser, count: 0 });
        }
    });

    // ----- TYPING INDICATORS -----
    const typingTimeouts = new Map();

    socket.on('typing_start', data => {
        const nickname = getUserNickname();
        if (!nickname) return;

        const room = data.room || socket.currentRoom;
        if (!room) return;

        // Broadcast to room
        socket.to(room).emit('typing_indicator', { nickname, isTyping: true });

        // Clear existing timeout
        const key = `${socket.id}_${room}`;
        if (typingTimeouts.has(key)) clearTimeout(typingTimeouts.get(key));

        // Auto-stop after timeout
        typingTimeouts.set(key, setTimeout(() => {
            socket.to(room).emit('typing_indicator', { nickname, isTyping: false });
            typingTimeouts.delete(key);
        }, TYPING_TIMEOUT_MS));
    });

    socket.on('typing_stop', data => {
        const nickname = getUserNickname();
        if (!nickname) return;

        const room = data.room || socket.currentRoom;
        if (!room) return;

        const key = `${socket.id}_${room}`;
        if (typingTimeouts.has(key)) {
            clearTimeout(typingTimeouts.get(key));
            typingTimeouts.delete(key);
        }

        socket.to(room).emit('typing_indicator', { nickname, isTyping: false });
    });

    // ----- CLEANUP ON DISCONNECT -----
    socket.on('disconnect', () => {
        const nickname = getUserNickname();
        if (nickname) {
            state.nicksToSockets.delete(nickname);
            io.sockets.emit('user_offline', { nickname, online: false });

            if (socket.currentRoom && state.usersByRoom[socket.currentRoom]) {
                state.usersByRoom[socket.currentRoom] = state.usersByRoom[socket.currentRoom]
                    .filter(id => id !== socket.id);
                updateRoomUsers(socket.currentRoom);
            }
            socket.leave(socket.currentRoom);
        }
        state.socketsToNicks.delete(socket.id);

        // Clean up typing timeouts
        for (const [key, timeout] of typingTimeouts.entries()) {
            if (key.startsWith(socket.id)) {
                clearTimeout(timeout);
                typingTimeouts.delete(key);
            }
        }
    });

    // Initialize on connection
    emitRoomUpdate();
});
