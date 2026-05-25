# Multi-Room Chat Application

A real-time chat application with room management, private messaging, typing indicators, and mobile support — built with **Socket.IO** and **Node.js**.

## Features

- **Multi-room chat** — create, join, and delete rooms with optional password protection
- **Private messaging** — one-on-one chats with message history and unread badges
- **Reply to messages** — threaded reply indicators in both room and private chats
- **Message deletion** — delete your own messages; room owners can delete any room message
- **Room moderation** — kick (timed) and ban users; unkick and unban support
- **Typing indicators** — see when others are typing in your room
- **Online status** — green dots show who's online
- **Connection status** — real-time connected/reconnecting/disconnected bar
- **Toast notifications** — non-blocking in-app alerts for all events
- **Emoji shortcodes** — `:)` → 😊, `:fire:` → 🔥, and more
- **URL auto-linkification** — links become clickable
- **Mobile responsive** — fully usable on phones and tablets
- **Keyboard accessible** — ARIA labels, roles, focus styles, screen reader support
- **Sound notifications** — subtle beep when receiving messages while tab is inactive
- **Nickname colors** — each user gets a consistent color for easy identification
- **Date separators** — message groups divided by day
- **Scroll management** — auto-scroll when at bottom; scroll-to-bottom button when reading history
- **Reconnection handling** — auto-reconnects after server restart with session restoration

## Quick Start

```bash
cd socketio-chat-app
npm install
npm start
```

Open `http://localhost:3456` in your browser.

For development with auto-restart:
```bash
npm run dev
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3456` | HTTP server port |
| `MAX_MESSAGE_LENGTH` | `2000` | Maximum characters per message |

## Architecture

```
chat-server.js    — Node.js HTTP server + Socket.IO (state in memory)
client.html       — HTML structure with accessibility attributes
client.js         — All client-side logic (Socket.IO events, UI rendering)
style.css         — Design system with CSS custom properties, responsive
package.json      — Dependencies and scripts
```

### Event Protocol

**Client → Server**: `set_nickname`, `message_to_server`, `create_room`, `join_room`, `delete_room`, `kick_user`, `ban_user`, `unban_user`, `unkick_user`, `private_message`, `delete_message`, `open_private_chat`, `typing_start`, `typing_stop`

**Server → Client**: `nickname_set`, `message_to_client`, `update_rooms`, `update_users`, `join_room_success`, `private_message`, `private_chat_history`, `error_message`, `kicked`, `banned`, `force_join`, `room_deleted`, `message_deleted`, `typing_indicator`, `user_online`, `user_offline`, `unread_count`

## Server API

| Endpoint | Description |
|----------|-------------|
| `GET /` | Chat application |
| `GET /client.html` | Chat application |
| `GET /style.css` | Stylesheet |
| `GET /client.js` | Client-side JavaScript |
| `GET /health` | JSON health check |

## License

ISC
