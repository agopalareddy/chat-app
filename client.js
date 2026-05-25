// ── State ───────────────────────────────────────────────
const socketio = io.connect();
const state = {
    currentRoom: null,
    nickname: localStorage.getItem('nickname'),
    isRoomCreator: false,
    currentChat: 'room',
    activePrivateChats: new Set(),
    closedChats: new Set(JSON.parse(localStorage.getItem('closedChats') || '[]')),
    onlineUsers: new Set(),
    userScrolledUp: false
};

const replyState = {
    replyingTo: null,
    replyingToRoom: null
};

// ── Sanitization ────────────────────────────────────────
function sanitize(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
              .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Hash color for nicknames ────────────────────────────
const NICK_COLORS = ['#e74c3c','#e67e22','#f1c40f','#2ecc71','#1abc9c','#3498db',
                     '#9b59b6','#e91e63','#00bcd4','#ff5722','#795548','#607d8b'];

function getNickColor(nickname) {
    let hash = 0;
    for (let i = 0; i < nickname.length; i++) {
        hash = nickname.charCodeAt(i) + ((hash << 5) - hash);
    }
    return NICK_COLORS[Math.abs(hash) % NICK_COLORS.length];
}

// ── Emoji shortcodes ────────────────────────────────────
const EMOJI_MAP = {
    ':)': '\u{1F60A}', ':(': '\u{1F622}', ':D': '\u{1F603}', ';)': '\u{1F609}',
    ':P': '\u{1F61B}', '<3': '\u2764\uFE0F', ':thumbsup:': '\u{1F44D}',
    ':fire:': '\u{1F525}', ':clap:': '\u{1F44F}', ':laughing:': '\u{1F602}',
    ':ok:': '\u{1F44C}', ':wave:': '\u{1F44B}', ':heart:': '\u2764\uFE0F',
    ':100:': '\u{1F4AF}', ':smile:': '\u{1F60A}', ':sad:': '\u{1F622}',
    ':angry:': '\u{1F620}', ':cool:': '\u{1F60E}', ':wink:': '\u{1F609}',
    ':star:': '\u2B50', ':check:': '\u2705', ':x:': '\u274C',
    ':rocket:': '\u{1F680}'
};

function convertEmoji(text) {
    let result = text;
    for (const [shortcode, emoji] of Object.entries(EMOJI_MAP)) {
        result = result.split(shortcode).join(emoji);
    }
    return result;
}

// ── URL linkification ───────────────────────────────────
function linkify(text) {
    const urlRegex = /(https?:\/\/[^\s<]+)/g;
    return text.replace(urlRegex, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

// ── Toast system ────────────────────────────────────────
function showToast(message, type, duration) {
    type = type || 'info';
    duration = duration || 4000;
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.setAttribute('role', 'alert');
    toast.textContent = message;
    container.appendChild(toast);
    requestAnimationFrame(function() { toast.classList.add('visible'); });
    setTimeout(function() {
        toast.classList.remove('visible');
        setTimeout(function() { toast.remove(); }, 300);
    }, duration);
}

// ── Confirm dialog ──────────────────────────────────────
function showConfirm(message) {
    return new Promise(function(resolve) {
        const dialog = document.getElementById('confirm-dialog');
        const text = document.getElementById('confirm-dialog-text');
        const yesBtn = document.getElementById('confirm-dialog-yes');
        const noBtn = document.getElementById('confirm-dialog-no');
        text.textContent = message;
        dialog.classList.remove('hidden');
        function cleanup(result) {
            dialog.classList.add('hidden');
            yesBtn.removeEventListener('click', onYes);
            noBtn.removeEventListener('click', onNo);
            resolve(result);
        }
        function onYes() { cleanup(true); }
        function onNo() { cleanup(false); }
        yesBtn.addEventListener('click', onYes);
        noBtn.addEventListener('click', onNo);
    });
}

// ── Sound notification ──────────────────────────────────
let audioCtx = null;

function playNotificationSound() {
    if (document.hidden) {
        try {
            if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.frequency.value = 800;
            osc.type = 'sine';
            gain.gain.setValueAtTime(0.1, audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.15);
            osc.start(audioCtx.currentTime);
            osc.stop(audioCtx.currentTime + 0.15);
        } catch (e) { /* Audio not supported */ }
    }
}

// ── Connection status ───────────────────────────────────
function updateConnectionStatus(status) {
    const el = document.getElementById('connection-status');
    if (!el) return;
    el.className = 'connection-status status-' + status;
    if (status === 'connected') el.textContent = '';
    else if (status === 'reconnecting') el.textContent = 'Reconnecting...';
    else el.textContent = 'Disconnected';
}

// ── Typing indicator ────────────────────────────────────
let typingTimer = null;
let isTyping = false;
const activeTypists = new Map();

function updateTypingIndicator() {
    const el = document.getElementById('typing-indicator');
    if (!el) return;
    const typists = Array.from(activeTypists.entries())
        .filter(function(entry) { return Date.now() - entry[1] < 5000; })
        .map(function(entry) { return entry[0]; });
    if (typists.length === 0) { el.textContent = ''; return; }
    if (typists.length === 1) el.textContent = typists[0] + ' is typing...';
    else if (typists.length === 2) el.textContent = typists[0] + ' and ' + typists[1] + ' are typing...';
    else el.textContent = typists[0] + ' and ' + (typists.length - 1) + ' others are typing...';
}

// ── Scroll helpers ──────────────────────────────────────
function isAtBottom(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 50;
}

function scrollToBottom(container) {
    container.scrollTop = container.scrollHeight;
}

function updateScrollButton(container) {
    const btn = document.getElementById('scroll-bottom-btn');
    if (!btn) return;
    if (container && !isAtBottom(container)) {
        btn.classList.remove('hidden');
        state.userScrolledUp = true;
    } else {
        btn.classList.add('hidden');
        state.userScrolledUp = false;
    }
}

// ── Date separator ──────────────────────────────────────
function getDateLabel(ts) {
    const d = new Date(ts);
    const now = new Date();
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (d.toDateString() === now.toDateString()) return 'Today';
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
    return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
}

function insertDateSeparator(container, timestamp) {
    const d = new Date(timestamp).toDateString();
    const lastSep = container.lastElementChild;
    if (lastSep && lastSep.classList.contains('date-separator') && lastSep.dataset.date === d) return;
    const sep = document.createElement('div');
    sep.className = 'date-separator';
    sep.dataset.date = d;
    sep.textContent = '\u2014 ' + getDateLabel(timestamp) + ' \u2014';
    container.appendChild(sep);
}

// ── Message rendering ───────────────────────────────────
function renderMessageContent(message, formattedTime, from) {
    let text = convertEmoji(message);
    text = linkify(text);
    text = text.replace(/\n/g, '<br>');
    const color = getNickColor(from);
    const timeHtml = '<span class="msg-time">' + (formattedTime || '') + '</span>';
    return timeHtml + ' <span class="msg-author" style="color:' + color + '">' + from + '</span>: ' + text;
}

function createMessageElement(containerId, data) {
    const container = document.getElementById(containerId);
    if (!container) return null;

    const wasAtBottom = isAtBottom(container);
    const isOwn = data.from === state.nickname;
    const messageDiv = document.createElement('div');
    messageDiv.className = 'message ' + (isOwn ? 'message-own' : 'message-other') + (data.replyTo ? ' reply' : '');
    messageDiv.id = 'message-' + data.messageId;

    let html = '';
    if (data.replyTo && data.replyTo.messageId) {
        html += '<div class="reply-indicator" onclick="scrollToMessage(\'' + (data.replyTo.messageId || '') + '\')">\u21AA Replying to ' + (data.replyTo.from || '') + ': ' + ((data.replyTo.preview || '').substring(0, 30)) + '</div>';
    }
    html += renderMessageContent(data.message || '', data.formattedTime, data.from);

    html += '<div class="controls">';
    html += '<button title="Reply" aria-label="Reply" onclick="replyToMessage(\'' + (data.messageId || '') + '\',\'' + (data.from || '') + '\',this.closest(\'.message\'))"><span class="material-icons">reply</span></button>';
    if (data.from === state.nickname) {
        const isPrivate = containerId.indexOf('private-chat-') === 0;
        const otherUser = isPrivate ? containerId.replace('private-chat-', '') : '';
        html += '<button title="Delete" aria-label="Delete" onclick="deleteMessage(\'' + (data.messageId || '') + '\',\'' + (isPrivate ? 'private' : 'room') + '\',\'' + otherUser + '\')"><span class="material-icons">delete</span></button>';
    }
    html += '</div>';

    messageDiv.innerHTML = html;
    insertDateSeparator(container, Date.now());
    container.appendChild(messageDiv);

    if (wasAtBottom) scrollToBottom(container);
    updateScrollButton(container);

    return messageDiv;
}

function appendMessage(containerId, data) {
    createMessageElement(containerId, {
        messageId: data.messageId,
        from: data.from,
        message: data.message,
        formattedTime: data.formattedTime,
        replyTo: data.replyTo || null
    });
}

function appendPrivateMessage(user, data) {
    const containerId = 'private-chat-' + user;
    var container = document.getElementById(containerId);
    if (!container) {
        openPrivateChat(user);
        container = document.getElementById(containerId);
    }
    if (!container) return;
    createMessageElement(containerId, {
        messageId: data.messageId,
        from: data.from,
        message: data.message,
        formattedTime: data.formattedTime || data.timestamp,
        replyTo: data.replyTo || null
    });
}

// ── UI Toggle ───────────────────────────────────────────
function toggleVisibility(id, show) {
    const el = document.getElementById(id);
    if (!el) return;
    if (show) el.classList.remove('hidden');
    else el.classList.add('hidden');
}

// ── Chat switching ──────────────────────────────────────
function switchChat(chatId) {
    state.currentChat = chatId;
    document.querySelectorAll('.chat-tab').forEach(function(tab) {
        tab.classList.remove('active');
        tab.setAttribute('aria-selected', 'false');
        if (tab.getAttribute('data-chat') === chatId) {
            tab.classList.add('active');
            tab.setAttribute('aria-selected', 'true');
        }
    });

    const roomChat = document.getElementById('chatlog');
    roomChat.classList.toggle('hidden', chatId !== 'room');

    document.querySelectorAll('.private-chat').forEach(function(chat) { chat.classList.remove('active'); });
    if (chatId !== 'room') {
        const otherUser = chatId.replace('private-', '');
        const pc = document.getElementById('private-chat-' + otherUser);
        if (pc) pc.classList.add('active');
    }
}

// ── Room management ─────────────────────────────────────
function joinRoom(roomName, hasPassword, roomOwner) {
    if (roomName === state.currentRoom) return;

    if (hasPassword && state.nickname !== roomOwner) {
        showPasswordModal(roomName);
        return;
    }

    state.currentRoom = roomName;
    state.isRoomCreator = false;
    socketio.emit('join_room', { room: roomName, password: '' });
}

function showPasswordModal(roomName) {
    const modal = document.getElementById('password-modal');
    const roomEl = document.getElementById('password-modal-room');
    const input = document.getElementById('password-modal-input');
    const submit = document.getElementById('password-modal-submit');
    const cancel = document.getElementById('password-modal-cancel');

    roomEl.textContent = 'Enter password for: ' + roomName;
    input.value = '';
    modal.classList.remove('hidden');
    input.focus();

    function cleanup() {
        modal.classList.add('hidden');
        submit.removeEventListener('click', onSubmit);
        cancel.removeEventListener('click', onCancel);
    }

    function onSubmit() {
        cleanup();
        state.currentRoom = roomName;
        state.isRoomCreator = false;
        socketio.emit('join_room', { room: roomName, password: input.value });
    }

    function onCancel() { cleanup(); }

    submit.addEventListener('click', onSubmit);
    cancel.addEventListener('click', onCancel);
    input.addEventListener('keypress', function(e) { if (e.key === 'Enter') onSubmit(); });
}

function createRoom() {
    const roomInput = document.getElementById('new_room_input');
    const passInput = document.getElementById('room_password');
    const room = roomInput.value.trim();
    const password = passInput.value;

    if (room) {
        state.isRoomCreator = true;
        socketio.emit('create_room', { room: room, password: password });
        roomInput.value = '';
        passInput.value = '';
    }
}

// ── User management ─────────────────────────────────────
function setNickname() {
    const input = document.getElementById('nickname_input');
    const newNickname = input.value.trim();
    if (newNickname) {
        state.nickname = newNickname;
        localStorage.setItem('nickname', newNickname);
        socketio.emit('set_nickname', newNickname);
    }
}

function kickUser(userId) {
    const container = document.getElementById('user_list');
    const existing = container.querySelector('.kick-form');
    if (existing) existing.remove();

    const form = document.createElement('div');
    form.className = 'kick-form';
    form.innerHTML = '<label>Duration (min): <input type="number" class="kick-duration" min="1" max="1440" value="5"></label><button class="kick-confirm">Kick</button><button class="kick-cancel">Cancel</button>';

    const targetEl = container.querySelector('[data-user="' + userId + '"]');
    if (targetEl) targetEl.after(form);

    form.querySelector('.kick-confirm').addEventListener('click', function() {
        const dur = parseInt(form.querySelector('.kick-duration').value);
        if (isNaN(dur) || dur < 1 || dur > 1440) {
            showToast('Duration must be 1-1440 minutes', 'error');
            return;
        }
        socketio.emit('kick_user', { userId: userId, room: state.currentRoom, duration: dur });
        form.remove();
    });

    form.querySelector('.kick-cancel').addEventListener('click', function() { form.remove(); });
}

function banUser(userId) {
    showConfirm('Ban ' + userId + ' from this room?').then(function(yes) {
        if (yes) socketio.emit('ban_user', { userId: userId, room: state.currentRoom });
    });
}

function unbanUser(userId) { socketio.emit('unban_user', { userId: userId, room: state.currentRoom }); }
function unkickUser(userId) { socketio.emit('unkick_user', { userId: userId, room: state.currentRoom }); }

// ── Private chat ────────────────────────────────────────
function openPrivateChat(otherUser) {
    if (state.nickname === otherUser) return;

    if (!state.activePrivateChats.has(otherUser)) {
        state.activePrivateChats.add(otherUser);
        state.closedChats.delete(otherUser);
        localStorage.setItem('closedChats', JSON.stringify(Array.from(state.closedChats)));

        const tabsContainer = document.getElementById('chat-tabs');
        const newTab = document.createElement('div');
        newTab.className = 'chat-tab';
        newTab.setAttribute('data-chat', 'private-' + otherUser);
        newTab.setAttribute('role', 'tab');
        newTab.setAttribute('tabindex', '0');
        newTab.innerHTML = otherUser + ' <span class="tab-close" onclick="closePrivateChat(\'' + otherUser + '\',event)"><span class="material-icons">close</span></span><span class="unread-badge hidden"></span>';
        newTab.addEventListener('click', function() { switchChat('private-' + otherUser); });
        newTab.addEventListener('keypress', function(e) { if (e.key === 'Enter') switchChat('private-' + otherUser); });
        tabsContainer.appendChild(newTab);

        const container = document.getElementById('private-chats');
        const newChat = document.createElement('div');
        newChat.id = 'private-chat-' + otherUser;
        newChat.className = 'private-chat';
        newChat.setAttribute('role', 'log');
        newChat.setAttribute('aria-live', 'polite');
        container.appendChild(newChat);

        socketio.emit('open_private_chat', otherUser);
    }

    switchChat('private-' + otherUser);
}

function closePrivateChat(otherUser, event) {
    if (event) event.stopPropagation();
    const chatTab = document.querySelector('[data-chat="private-' + otherUser + '"]');
    const chatContainer = document.getElementById('private-chat-' + otherUser);
    if (chatTab) chatTab.remove();
    if (chatContainer) chatContainer.remove();
    state.activePrivateChats.delete(otherUser);
    state.closedChats.add(otherUser);
    localStorage.setItem('closedChats', JSON.stringify(Array.from(state.closedChats)));
    if (state.currentChat === 'private-' + otherUser) switchChat('room');
}

// ── Message actions ─────────────────────────────────────
function deleteMessage(messageId, type, otherUser) {
    showConfirm('Delete this message?').then(function(yes) {
        if (yes) socketio.emit('delete_message', { messageId: messageId, room: state.currentRoom, type: type, otherUser: otherUser });
    });
}

function replyToMessage(messageId, from, messageElement) {
    const messageText = messageElement.getAttribute('data-message-text') || messageElement.textContent || '';
    replyState.replyingTo = { messageId: messageId, from: from, preview: messageText.substring(0, 30) + (messageText.length > 30 ? '...' : '') };
    replyState.replyingToRoom = state.currentRoom;
    showReplyIndicator(from);
}

function showReplyIndicator(from) {
    const container = document.querySelector('.message-input-container');
    var el = container.querySelector('.replying-to');
    if (!el) {
        el = document.createElement('div');
        el.className = 'replying-to';
        container.insertBefore(el, container.firstChild);
    }
    el.innerHTML = '<span>Replying to ' + from + ': ' + (replyState.replyingTo.preview || '') + '</span><button class="cancel-reply" onclick="cancelReply()" aria-label="Cancel reply"><span class="material-icons">close</span></button>';
    document.getElementById('message_input').focus();
}

function cancelReply() {
    replyState.replyingTo = null;
    replyState.replyingToRoom = null;
    const el = document.querySelector('.replying-to');
    if (el) el.remove();
}

function scrollToMessage(messageId) {
    const msg = document.getElementById('message-' + messageId);
    if (msg) {
        msg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        msg.style.backgroundColor = '#fff3cd';
        setTimeout(function() { msg.style.backgroundColor = ''; }, 2000);
    }
}

// ── Send message ────────────────────────────────────────
function sendMessage() {
    const msgInput = document.getElementById('message_input');
    const msg = msgInput.value.trim();
    if (!msg) return;

    const replyData = replyState.replyingTo ? {
        messageId: replyState.replyingTo.messageId,
        from: replyState.replyingTo.from,
        preview: replyState.replyingTo.preview
    } : null;

    if (state.currentChat === 'room') {
        socketio.emit('message_to_server', { message: msg, room: state.currentRoom, replyTo: replyData });
    } else {
        const otherUser = state.currentChat.replace('private-', '');
        socketio.emit('private_message', { to: otherUser, message: msg, replyTo: replyData });
    }

    msgInput.value = '';
    msgInput.style.height = 'auto';
    cancelReply();
}

function logout() {
    showConfirm('Are you sure you want to log out?').then(function(yes) {
        if (!yes) return;
        localStorage.removeItem('nickname');
        localStorage.removeItem('closedChats');
        state.nickname = null;
        state.currentRoom = null;
        state.isRoomCreator = false;
        state.currentChat = 'room';
        state.activePrivateChats.clear();
        state.closedChats.clear();
        document.getElementById('chatlog').innerHTML = '';
        document.getElementById('private-chats').innerHTML = '';
        document.getElementById('chat-tabs').innerHTML = '<div class="chat-tab active" data-chat="room" id="roomChatTab" role="tab" tabindex="0" aria-selected="true">Room Chat</div>';
        toggleVisibility('chat-interface', false);
        toggleVisibility('nickname-form', true);
        document.getElementById('nickname_input').value = '';
        document.getElementById('room_list').innerHTML = '';
    });
}

// ── UI Elements ─────────────────────────────────────────
function createRoomElement(room, isCurrentRoom) {
    const div = document.createElement('div');
    div.className = 'room' + (isCurrentRoom ? ' current' : '');
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', 'Join room ' + room.name);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = room.name;
    div.appendChild(nameSpan);

    const controlsDiv = document.createElement('div');
    controlsDiv.className = 'room-controls';

    if (room.hasPassword) {
        const lockIcon = document.createElement('span');
        lockIcon.className = 'material-icons';
        lockIcon.textContent = 'lock';
        lockIcon.title = 'Password Protected';
        lockIcon.setAttribute('aria-label', 'Password protected');
        controlsDiv.appendChild(lockIcon);
    }

    if (room.owner === state.nickname && room.name !== 'Lobby') {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'delete-room-btn';
        deleteBtn.innerHTML = '<span class="material-icons">delete_outline</span>';
        deleteBtn.title = 'Delete Room';
        deleteBtn.setAttribute('aria-label', 'Delete room ' + room.name);
        deleteBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            showConfirm('Delete room ' + room.name + '?').then(function(yes) {
                if (yes) socketio.emit('delete_room', { room: room.name });
            });
        });
        controlsDiv.appendChild(deleteBtn);
    }

    if (controlsDiv.children.length > 0) div.appendChild(controlsDiv);

    div.addEventListener('click', function() { joinRoom(room.name, room.hasPassword, room.owner); });
    div.addEventListener('keypress', function(e) { if (e.key === 'Enter') joinRoom(room.name, room.hasPassword, room.owner); });
    return div;
}

function createUserElement(user, roomOwner) {
    const div = document.createElement('div');
    div.className = 'user-item' + (user === state.nickname ? ' current-user' : '');
    div.setAttribute('data-user', user);
    div.setAttribute('role', 'button');
    div.setAttribute('tabindex', '0');
    div.setAttribute('aria-label', 'User ' + user);

    const dot = document.createElement('span');
    dot.className = 'online-dot ' + (state.onlineUsers.has(user) ? 'online' : 'offline');
    dot.setAttribute('aria-hidden', 'true');
    div.appendChild(dot);

    const nameSpan = document.createElement('span');
    nameSpan.textContent = user;
    div.appendChild(nameSpan);

    if (state.currentRoom && roomOwner === state.nickname && user !== state.nickname) {
        const controls = document.createElement('div');
        controls.className = 'user-controls';

        const kickBtn = document.createElement('button');
        kickBtn.title = 'Kick User';
        kickBtn.setAttribute('aria-label', 'Kick ' + user);
        kickBtn.innerHTML = '<span class="material-icons">timer_off</span>';
        kickBtn.addEventListener('click', function(e) { e.stopPropagation(); kickUser(user); });
        controls.appendChild(kickBtn);

        const banBtn = document.createElement('button');
        banBtn.title = 'Ban User';
        banBtn.setAttribute('aria-label', 'Ban ' + user);
        banBtn.innerHTML = '<span class="material-icons">block</span>';
        banBtn.addEventListener('click', function(e) { e.stopPropagation(); banUser(user); });
        controls.appendChild(banBtn);

        div.appendChild(controls);
    }

    div.addEventListener('click', function() { if (user !== state.nickname) openPrivateChat(user); });
    div.addEventListener('keypress', function(e) { if (e.key === 'Enter' && user !== state.nickname) openPrivateChat(user); });
    return div;
}

// ── Socket Event Handlers ───────────────────────────────
socketio.on('nickname_set', function(data) {
    toggleVisibility('nickname-form', false);
    toggleVisibility('chat-interface', true);

    if (data.privateChats) {
        data.privateChats.forEach(function(chat) {
            if (!state.closedChats.has(chat.otherUser)) {
                openPrivateChat(chat.otherUser);
                const container = document.getElementById('private-chat-' + chat.otherUser);
                if (container) {
                    chat.messages.forEach(function(msg) {
                        appendPrivateMessage(chat.otherUser, {
                            from: msg.from,
                            message: msg.message,
                            formattedTime: msg.formattedTime,
                            messageId: msg.messageId,
                            replyTo: msg.replyTo || null
                        });
                    });
                }
            }
        });
    }

    joinRoom('Lobby', false);
});

socketio.on('message_to_client', function(data) {
    if (data.type === 'system') {
        const container = document.getElementById('chatlog');
        if (!container) return;
        const div = document.createElement('div');
        div.className = 'message system-message';
        div.id = 'message-' + data.messageId;
        div.textContent = '[' + (data.formattedTime || '') + '] ' + data.message;
        container.appendChild(div);
        if (isAtBottom(container)) scrollToBottom(container);
        updateScrollButton(container);
    } else {
        appendMessage('chatlog', data);
    }
    playNotificationSound();
});

socketio.on('update_rooms', function(rooms) {
    const roomList = document.getElementById('room_list');
    roomList.innerHTML = '<h3>Available Rooms</h3>';
    rooms.forEach(function(room) {
        roomList.appendChild(createRoomElement(room, room.name === state.currentRoom));
    });
});

socketio.on('update_users', function(data) {
    const userList = document.getElementById('user_list');
    userList.innerHTML = '<h3>Users in Room</h3>';

    data.users.forEach(function(user) {
        userList.appendChild(createUserElement(user, data.roomOwner));
    });

    const roomEl = document.getElementById('current_room');
    if (roomEl) {
        const count = data.users.length;
        roomEl.textContent = 'Current Room: ' + (state.currentRoom || 'None') + ' (' + count + ' user' + (count !== 1 ? 's' : '') + ')';
    }

    const bannedList = document.getElementById('banned_users_list');
    const kickedList = document.getElementById('kicked_users_list');

    if (state.nickname === data.roomOwner) {
        if (data.bannedUsers && data.bannedUsers.length > 0) {
            bannedList.innerHTML = '<h4>Banned Users</h4>';
            data.bannedUsers.forEach(function(user) {
                const div = document.createElement('div');
                div.className = 'banned-user-item';
                div.textContent = user;
                const btn = document.createElement('button');
                btn.className = 'unban-btn';
                btn.textContent = 'Unban';
                btn.setAttribute('aria-label', 'Unban ' + user);
                btn.addEventListener('click', function() { unbanUser(user); });
                div.appendChild(btn);
                bannedList.appendChild(div);
            });
            bannedList.style.display = 'block';
        } else { bannedList.style.display = 'none'; }

        const kickEntries = Object.entries(data.kickedUsers || {});
        if (kickEntries.length > 0) {
            kickedList.innerHTML = '<h4>Kicked Users</h4>';
            kickEntries.forEach(function(entry) {
                const user = entry[0];
                const expirationTime = entry[1];
                const remaining = Math.ceil((expirationTime - Date.now()) / (60 * 1000));
                if (remaining > 0) {
                    const div = document.createElement('div');
                    div.className = 'banned-user-item';
                    div.textContent = user + ' (' + remaining + 'm remaining)';
                    const btn = document.createElement('button');
                    btn.className = 'unkick-btn';
                    btn.textContent = 'Unkick';
                    btn.setAttribute('aria-label', 'Unkick ' + user);
                    btn.addEventListener('click', function() { unkickUser(user); });
                    div.appendChild(btn);
                    kickedList.appendChild(div);
                }
            });
            kickedList.style.display = 'block';
        } else { kickedList.style.display = 'none'; }
    } else {
        bannedList.style.display = 'none';
        kickedList.style.display = 'none';
    }
});

socketio.on('private_message', function(data) {
    const otherUser = data.from === state.nickname ? data.to : data.from;
    appendPrivateMessage(otherUser, data);
    playNotificationSound();
});

socketio.on('join_room_success', function(data) {
    state.currentRoom = data.room;
    const chatlog = document.getElementById('chatlog');
    chatlog.innerHTML = '';

    if (data.messageHistory && data.messageHistory.length) {
        data.messageHistory.forEach(function(msg) {
            appendMessage('chatlog', {
                messageId: msg.messageId,
                from: msg.from,
                message: msg.message,
                formattedTime: msg.formattedTime,
                replyTo: msg.replyTo || null
            });
        });
    } else {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = '\u{1F44B} <strong>Welcome to ' + data.room + '!</strong><br>Be the first to say hello.';
        chatlog.appendChild(empty);
    }

    scrollToBottom(chatlog);
});

socketio.on('kicked', function(data) {
    const remaining = Math.ceil((data.expiration - Date.now()) / (60 * 1000));
    showToast('You have been kicked from ' + data.room + ' for ' + remaining + ' minutes', 'warning');
    if (state.currentRoom === data.room) state.currentRoom = null;
});

socketio.on('banned', function(data) {
    showToast(data.message || 'You have been banned from ' + data.room, 'error');
    if (state.currentRoom === data.room) state.currentRoom = null;
});

socketio.on('force_join', function(data) {
    document.getElementById('chatlog').innerHTML = '';
    joinRoom(data.room, false);
});

socketio.on('room_deleted', function(data) {
    showToast('Room "' + data.room + '" has been deleted', 'warning');
    document.getElementById('chatlog').innerHTML = '';
    document.getElementById('current_room').textContent = 'Current Room: None';
    if (state.currentRoom === data.room) state.currentRoom = null;
    joinRoom('Lobby', false);
});

socketio.on('error_message', function(data) {
    showToast(data.message, 'error');
});

socketio.on('message_deleted', function(data) {
    const el = document.getElementById('message-' + data.messageId);
    if (el) el.remove();
});

socketio.on('private_chat_history', function(data) {
    const container = document.getElementById('private-chat-' + data.otherUser);
    if (container && data.messages) {
        data.messages.forEach(function(msg) {
            appendPrivateMessage(data.otherUser, {
                from: msg.from,
                message: msg.message,
                formattedTime: msg.formattedTime,
                messageId: msg.messageId,
                replyTo: msg.replyTo || null
            });
        });
        container.scrollTop = container.scrollHeight;
    }
});

socketio.on('user_online', function(data) {
    state.onlineUsers.add(data.nickname);
});

socketio.on('user_offline', function(data) {
    state.onlineUsers.delete(data.nickname);
});

socketio.on('typing_indicator', function(data) {
    if (data.isTyping) activeTypists.set(data.nickname, Date.now());
    else activeTypists.delete(data.nickname);
    updateTypingIndicator();
});

socketio.on('unread_count', function(data) {
    const tab = document.querySelector('[data-chat="private-' + data.otherUser + '"]');
    if (!tab) return;
    const badge = tab.querySelector('.unread-badge');
    if (!badge) return;
    if (data.count > 0) {
        badge.textContent = data.count > 99 ? '99+' : data.count;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
});

// ── Connection events ───────────────────────────────────
socketio.on('connect', function() {
    updateConnectionStatus('connected');
    if (state.nickname) {
        socketio.emit('set_nickname', state.nickname);
        showToast('Reconnected!', 'success', 2000);
    }
});

socketio.on('disconnect', function() {
    updateConnectionStatus('disconnected');
    showToast('Connection lost', 'error');
});

socketio.on('reconnecting', function() { updateConnectionStatus('reconnecting'); });
socketio.on('reconnect_attempt', function() { updateConnectionStatus('reconnecting'); });

// ── Initialize on load ──────────────────────────────────
window.addEventListener('DOMContentLoaded', function() {
    document.getElementById('setNicknameBtn').addEventListener('click', setNickname);
    document.getElementById('logoutBtn').addEventListener('click', logout);
    document.getElementById('createRoomBtn').addEventListener('click', createRoom);
    document.getElementById('sendMessageBtn').addEventListener('click', sendMessage);
    document.getElementById('roomChatTab').addEventListener('click', function() { switchChat('room'); });

    document.getElementById('sidebar-toggle').addEventListener('click', function() {
        document.getElementById('sidebar').classList.toggle('collapsed');
    });

    document.getElementById('scroll-bottom-btn').addEventListener('click', function() {
        const container = state.currentChat === 'room'
            ? document.getElementById('chatlog')
            : document.getElementById('private-chat-' + state.currentChat.replace('private-', ''));
        if (container) { scrollToBottom(container); updateScrollButton(container); }
    });

    document.getElementById('chatlog').addEventListener('scroll', function() {
        updateScrollButton(this);
    });

    const msgInput = document.getElementById('message_input');
    msgInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });

    msgInput.addEventListener('input', function() {
        if (!isTyping) {
            isTyping = true;
            socketio.emit('typing_start', { room: state.currentRoom });
        }
        clearTimeout(typingTimer);
        typingTimer = setTimeout(function() {
            isTyping = false;
            socketio.emit('typing_stop', { room: state.currentRoom });
        }, 2000);
    });

    document.getElementById('nickname_input').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') setNickname();
    });

    msgInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            cancelReply();
            var kf = document.querySelector('.kick-form');
            if (kf) kf.remove();
            document.getElementById('password-modal').classList.add('hidden');
            document.getElementById('confirm-dialog').classList.add('hidden');
        }
    });

    if (state.nickname) {
        socketio.emit('set_nickname', state.nickname);
        toggleVisibility('nickname-form', false);
        toggleVisibility('chat-interface', true);
    }
});
