const http = require("http"),
    fs = require("fs");

const port = 3456;
const server = http.createServer((req, res) => {
    if (req.url === '/style.css') {
        fs.readFile('style.css', (err, data) => {
            if (err) return res.writeHead(500);
            res.writeHead(200, { 'Content-Type': 'text/css' });
            res.end(data);
        });
        return;
    }
    fs.readFile("client.html", (err, data) => {
        if (err) return res.writeHead(500);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    });
});

const io = require("socket.io")(http, { wsEngine: 'ws' }).listen(server);
server.listen(port);

// State management
const state = {
    rooms: ["Lobby"],
    usersByRoom: {},
    socketsToNicks: new Map(),
    nicksToSockets: new Map(),
    roomPasswords: new Map(),
    roomCreators: new Map(),
    bannedUsers: new Map(),
    kickedUsers: new Map(),
    userRoomHistory: new Map(),
    messages: {
        rooms: new Map(),
        private: new Map()
    }
};

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
        if (messages.length > 100) messages.shift();
    },

    deleteMessage: (type, id, messageId) => {
        if (state.messages[type].has(id)) {
            const messages = state.messages[type].get(id);
            state.messages[type].set(id, messages.filter(m => m.messageId !== messageId));
        }
    },

    cleanupMessages: () => {
        const dayAgo = Date.now() - (24 * 60 * 60 * 1000);
        ['rooms', 'private'].forEach(type => {
            for (const [id, messages] of state.messages[type].entries()) {
                state.messages[type].set(id, messages.filter(m => m.timestamp > dayAgo));
            }
        });
    }
};

// Run message cleanup hourly
setInterval(helpers.cleanupMessages, 60 * 60 * 1000);

io.sockets.on("connection", socket => {
    const emitRoomUpdate = () => io.sockets.emit("update_rooms", helpers.getRoomList());

    const getUserNickname = () => state.socketsToNicks.get(socket.id);

    const updateRoomUsers = (room) => {
        if (!state.usersByRoom[room]) return;

        // Get banned users for this room
        const bannedUsers = [];
        if (state.bannedUsers.has(room)) {
            state.bannedUsers.get(room).forEach(socketId => {
                const nickname = state.socketsToNicks.get(socketId);
                if (nickname) bannedUsers.push(nickname);
            });
        }

        // Get kicked users and their expiration times
        const kickedUsers = {};
        if (state.kickedUsers.has(room)) {
            for (const [userId, expirationTime] of state.kickedUsers.get(room).entries()) {
                if (Date.now() < expirationTime) {
                    kickedUsers[userId] = expirationTime;
                }
            }
        }

        io.sockets.in(room).emit("update_users", {
            users: state.usersByRoom[room].map(id => state.socketsToNicks.get(id)),
            roomOwner: state.roomCreators.get(room),
            bannedUsers,
            kickedUsers
        });
    };

    // Event handlers
    socket.on('set_nickname', nickname => {
        state.socketsToNicks.set(socket.id, nickname);
        state.nicksToSockets.set(nickname, socket.id);

        // Get user's private chat history
        const userChats = Array.from(state.messages.private.entries())
            .filter(([chatId, messages]) => {
                const [user1, user2] = chatId.split('_');
                return (user1 === nickname || user2 === nickname) &&
                    messages.some(m => (Date.now() - m.timestamp) < 86400000);
            })
            .map(([chatId, messages]) => ({
                otherUser: chatId.split('_').find(u => u !== nickname),
                messages
            }));

        socket.emit("nickname_set", { privateChats: userChats });
    });

    socket.on('message_to_server', data => {
        const nickname = getUserNickname();
        const timestamp = Date.now();
        const messageId = `${nickname}-${timestamp}`;
        const messageData = {
            type: 'room',
            from: nickname,
            message: data.message,
            timestamp,
            formattedTime: new Date(timestamp).toLocaleTimeString(),
            messageId,
            replyTo: data.replyTo
        };

        helpers.addMessage('rooms', data.room, messageData);
        io.sockets.in(data.room).emit("message_to_client", {
            message: `[${messageData.formattedTime}] ${nickname}: ${data.message}`,
            messageId,
            from: nickname,
            replyTo: data.replyTo
        });
    });

    // Room management
    const roomEvents = {
        create_room: data => {
            const { room, password } = data;
            if (!room || state.rooms.includes(room)) {
                return socket.emit('error_message', { message: 'Invalid or duplicate room name' });
            }

            const nickname = getUserNickname();
            if (password?.trim()) state.roomPasswords.set(room, password);
            state.roomCreators.set(room, nickname);
            state.rooms.push(room);
            emitRoomUpdate();
        },

        join_room: data => {
            const { room, password } = data;
            const nickname = getUserNickname();
            const isRoomOwner = state.roomCreators.get(room) === nickname;

            // Various checks (banned, kicked, password)
            if ((state.bannedUsers.get(room) || []).includes(socket.id) ||
                helpers.isUserKicked(nickname, room) ||
                (!isRoomOwner && state.roomPasswords.has(room) && state.roomPasswords.get(room) !== password)) {
                return socket.emit('error_message', { message: 'Cannot join room' });
            }

            // Handle room change
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

            // Initialize and update room history
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
                    message: `[${new Date().toLocaleTimeString()}] System: ${nickname} has joined the room`
                });
            }

            emitRoomUpdate();
            updateRoomUsers(room);
        },

        delete_room: data => {
            const { room } = data;
            if (room !== "Lobby" && state.roomCreators.get(room) === getUserNickname()) {
                state.rooms = state.rooms.filter(r => r !== room);
                delete state.usersByRoom[room];
                state.roomPasswords.delete(room);
                state.roomCreators.delete(room);
                state.bannedUsers.delete(room);

                io.sockets.in(room).emit("room_deleted", { room });
                const roomSockets = io.sockets.adapter.rooms.get(room);
                if (roomSockets) {
                    roomSockets.forEach(socketId => {
                        io.sockets.sockets.get(socketId).leave(room);
                    });
                }
                emitRoomUpdate();
            }
        }
    };

    // Register room events
    Object.entries(roomEvents).forEach(([event, handler]) => {
        socket.on(event, handler);
    });

    // Add kick and ban handlers
    socket.on('kick_user', data => {
        const { userId, room, duration } = data;
        const roomOwner = state.roomCreators.get(room);
        const kickerNickname = getUserNickname();

        // Validate kick permission and duration
        if (roomOwner !== kickerNickname || !duration || duration < 1 || duration > 1440) {
            return socket.emit('error_message', { message: 'Invalid kick request' });
        }

        const userSocketId = state.nicksToSockets.get(userId);
        if (!userSocketId || userId === roomOwner) {
            return socket.emit('error_message', { message: 'Cannot kick this user' });
        }

        // Set kick expiration
        if (!state.kickedUsers.has(room)) {
            state.kickedUsers.set(room, new Map());
        }
        const expirationTime = Date.now() + (duration * 60 * 1000);
        state.kickedUsers.get(room).set(userId, expirationTime);

        // Remove user from room
        const kickedSocket = io.sockets.sockets.get(userSocketId);
        if (kickedSocket) {
            kickedSocket.leave(room);
            if (kickedSocket.currentRoom === room) {
                kickedSocket.currentRoom = null;
            }

            // Update room's user list
            if (state.usersByRoom[room]) {
                state.usersByRoom[room] = state.usersByRoom[room].filter(id => id !== userSocketId);
                updateRoomUsers(room);
            }

            // Notify kicked user and room
            kickedSocket.emit('kicked', { room, duration, expiration: expirationTime });
            io.sockets.in(room).emit('message_to_client', {
                message: `[${new Date().toLocaleTimeString()}] System: ${userId} has been kicked for ${duration} minutes`
            });
        }
    });

    socket.on('ban_user', data => {
        const { userId, room } = data;
        const roomOwner = state.roomCreators.get(room);
        const bannerNickname = getUserNickname();

        // Validate ban permission
        if (roomOwner !== bannerNickname) {
            return socket.emit('error_message', { message: 'Only room owner can ban users' });
        }

        const userSocketId = state.nicksToSockets.get(userId);
        if (!userSocketId || userId === roomOwner) {
            return socket.emit('error_message', { message: 'Cannot ban this user' });
        }

        // Add to banned users
        if (!state.bannedUsers.has(room)) {
            state.bannedUsers.set(room, []);
        }
        state.bannedUsers.get(room).push(userSocketId);

        // Remove from room if present
        const bannedSocket = io.sockets.sockets.get(userSocketId);
        if (bannedSocket) {
            bannedSocket.leave(room);
            if (bannedSocket.currentRoom === room) {
                bannedSocket.currentRoom = null;
                // Send clear notification to banned user
                bannedSocket.emit('banned', {
                    room,
                    message: `You have been banned from ${room}`
                });
            }

            // Update room's user list
            if (state.usersByRoom[room]) {
                state.usersByRoom[room] = state.usersByRoom[room].filter(id => id !== userSocketId);
                updateRoomUsers(room);
            }

            // System message to room
            io.sockets.in(room).emit('message_to_client', {
                message: `[${new Date().toLocaleTimeString()}] System: ${userId} has been banned from the room`,
                type: 'system'
            });

            // Force client to switch to Lobby if in banned room
            bannedSocket.emit('join_room', { room: 'Lobby' });
        }
    });

    // Add unban/unkick handlers
    socket.on('unban_user', data => {
        const { userId, room } = data;
        if (state.roomCreators.get(room) === getUserNickname()) {
            if (state.bannedUsers.has(room)) {
                const bannedList = state.bannedUsers.get(room);
                const userSocketId = state.nicksToSockets.get(userId);

                // Remove from banned list
                state.bannedUsers.set(room,
                    bannedList.filter(id => id !== userSocketId)
                );

                // Notify room of unban
                io.sockets.in(room).emit('message_to_client', {
                    message: `[${new Date().toLocaleTimeString()}] System: ${userId} has been unbanned`,
                    type: 'system'
                });

                // Update room users list
                updateRoomUsers(room);
            }
        }
    });

    socket.on('unkick_user', data => {
        const { userId, room } = data;
        if (state.roomCreators.get(room) === getUserNickname()) {
            if (state.kickedUsers.has(room)) {
                // Remove kick record
                state.kickedUsers.get(room).delete(userId);

                // Notify room of unkick
                io.sockets.in(room).emit('message_to_client', {
                    message: `[${new Date().toLocaleTimeString()}] System: ${userId} has been unkicked`,
                    type: 'system'
                });

                // Update room users list
                updateRoomUsers(room);
            }
        }
    });

    // Chat events
    socket.on('private_message', data => {
        const { to, message, replyTo } = data;
        const fromNick = getUserNickname();
        const toSocketId = state.nicksToSockets.get(to);

        if (!toSocketId) {
            return socket.emit('error_message', { message: 'User not found or offline' });
        }

        const chatId = helpers.getPrivateChatId(fromNick, to);
        const timestamp = Date.now();
        const messageId = `${fromNick}-${timestamp}`;
        const messageData = {
            type: 'private',
            from: fromNick,
            to,
            message,
            timestamp,
            messageId,
            formattedTime: new Date(timestamp).toLocaleTimeString(),
            replyTo
        };

        helpers.addMessage('private', chatId, messageData);
        [toSocketId, socket.id].forEach(id =>
            io.to(id).emit('private_message', messageData));
    });

    // Modify delete message handler to support private messages
    socket.on('delete_message', data => {
        const { messageId, room, type, otherUser } = data;
        const nickname = getUserNickname();

        if (type === 'private') {
            const chatId = helpers.getPrivateChatId(nickname, otherUser);
            const messages = state.messages.private.get(chatId) || [];
            const message = messages.find(m => m.messageId === messageId);

            if (message && message.from === nickname) {
                helpers.deleteMessage('private', chatId, messageId);
                // Notify both users about the deletion
                [state.nicksToSockets.get(otherUser), socket.id].forEach(id =>
                    io.to(id).emit('message_deleted', { messageId, type: 'private', chatId }));
            } else {
                socket.emit('error_message', {
                    message: 'You can only delete your own messages'
                });
            }
        } else {
            // Existing room message deletion logic
            const messages = state.messages.rooms.get(room) || [];
            const message = messages.find(m => m.messageId === messageId);

            if (message && (message.from === nickname || state.roomCreators.get(room) === nickname)) {
                helpers.deleteMessage('rooms', room, messageId);
                io.sockets.in(room).emit('message_deleted', { messageId, type: 'room' });
            } else {
                socket.emit('error_message', {
                    message: 'You do not have permission to delete this message'
                });
            }
        }
    });

    socket.on('open_private_chat', (otherUser) => {
        const nickname = getUserNickname();
        const chatId = helpers.getPrivateChatId(nickname, otherUser);

        // Send message history for this private chat
        socket.emit('private_chat_history', {
            otherUser,
            messages: state.messages.private.get(chatId) || []
        });
    });

    // Cleanup on disconnect
    socket.on('disconnect', () => {
        const nickname = getUserNickname();
        if (nickname) {
            state.nicksToSockets.delete(nickname);
            if (socket.currentRoom && state.usersByRoom[socket.currentRoom]) {
                state.usersByRoom[socket.currentRoom] = state.usersByRoom[socket.currentRoom]
                    .filter(id => id !== socket.id);
                updateRoomUsers(socket.currentRoom);
            }
            socket.leave(socket.currentRoom);
        }
        state.socketsToNicks.delete(socket.id);
    });

    // Initialize rooms on connection
    emitRoomUpdate();
});