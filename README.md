# ChatSphere — Multi-Room Real-Time Chat App 💬✨

[![Course](https://img.shields.io/badge/WUSTL-CSE%20503S-blue.svg)](https://cse.wustl.edu/)
[![Framework](https://img.shields.io/badge/Socket.IO-4.x-black.svg)](https://socket.io/)
[![Runtime](https://img.shields.io/badge/Node.js-%3E%3D%2018-green.svg)](https://nodejs.org/)
[![Package Manager](https://img.shields.io/badge/npm-%3E%3D%209-red.svg)](https://www.npmjs.com/)
[![Backend](https://img.shields.io/badge/Express-4.x-lightgrey.svg)](https://expressjs.com/)
[![License](https://img.shields.io/badge/License-ISC-yellow.svg)](https://opensource.org/licenses/ISC)

> A modern, real-time multi-room messaging system featuring instant chat lobbies, password-protected custom rooms, private direct messages, threaded message replies, and robust administrative moderation controls. Built with Socket.IO and Express.

---

## 📌 Table of Contents

- [🌟 Key Features](#-key-features)
- [🛠️ Tech Stack & Architecture](#️-tech-stack--architecture)
- [⚙️ Setup & Local Installation](#-setup--local-installation)
- [🚀 Run & Quick Start](#-run--quick-start)
- [🛡️ Security & Architecture Best Practices](#️-security--architecture-best-practices)
- [🤝 Contributing & Support](#-contributing--support)
- [📄 License](#-license)

---

## 🌟 Key Features

- **💬 Multi-Room Chat Lobbies:** Instantly create, join, and browse rooms. Lobbies can be configured with optional password protection for private discussions.
- **✉️ Private Messaging:** Direct one-on-one private chats with distinct, real-time message histories and unread notification badges.
- **🧵 Message Thread Replies:** Native, context-aware threaded message replies inside both public lobbies and private conversations.
- **🗑️ Granular Message Deletion:** Users can instantly delete their own messages, while room creators maintain moderation overrides to delete any message in their room.
- **🛡️ Administrative Moderation:** Empower room creators to kick (temporarily time-out) or permanently ban problematic users, with full unkick/unban support.
- **✍️ Typing & Presence Indicators:** Dynamic typing alerts showing who is active, complemented by real-time green online presence dots.
- **📶 Connection Status Bar:** A premium, real-time visual indicator displaying current connection status (*Connected*, *Reconnecting*, *Disconnected*).
- **🔔 Toast & Audio Notifications:** Non-blocking in-app alert banners paired with subtle acoustic beeps for incoming messages when the browser tab is inactive.
- **🎨 Nickname Personalization:** Each user receives a unique, deterministic HSL color assigned to their nickname for rapid visual identification.
- **✨ Rich Text & Emoji Shortcodes:** Automatic replacement of emoji text patterns (e.g. `:)` → 😊, `:fire:` → 🔥) and regex-driven auto-linking for clickable URLs.

---

## 🛠️ Tech Stack & Architecture

### Technology Stack
- **Frontend Core**: Vanilla HTML5, ES6 ECMAScript (Socket.IO client, coordinator pattern, dynamic DOM updates)
- **Backend API & Server**: Node.js & Express (Static resource routing, health checks)
- **Real-Time Communication**: Socket.IO 4.x (WebSockets with engine.io fallback polling)
- **Styling System**: CSS Variables (Slate-dark palette, responsive layouts, modular layouts)

### Directory Structure
```
chat-app/
└── socketio-chat-app/
    ├── chat-server.js   # Core Express and Socket.IO server execution (Port 3456)
    ├── client.html      # Front-end layout and static accessibility-compliant elements
    ├── client.js        # DOM renderers, Event listeners, socket connections
    ├── style.css        # Responsive slate layout styling and modal designs
    └── package.json     # Node scripts and package dependencies listing
```

### Socket.IO Event Protocol
- **Client ➡️ Server**: `set_nickname`, `message_to_server`, `create_room`, `join_room`, `delete_room`, `kick_user`, `ban_user`, `unban_user`, `unkick_user`, `private_message`, `delete_message`, `open_private_chat`, `typing_start`, `typing_stop`
- **Server ➡️ Client**: `nickname_set`, `message_to_client`, `update_rooms`, `update_users`, `join_room_success`, `private_message`, `private_chat_history`, `error_message`, `kicked`, `banned`, `force_join`, `room_deleted`, `message_deleted`, `typing_indicator`, `user_online`, `user_offline`, `unread_count`

---

## ⚙️ Setup & Local Installation

### Prerequisites
* **Node.js** >= 18.x
* **npm** >= 9.x

### Installation
1. **Clone the Repository & Install Dependencies**:
   ```bash
   git clone https://github.com/agopalareddy/tales-we-weave.git # (Sub-repository path: chat-app/socketio-chat-app)
   cd chat-app/socketio-chat-app
   npm install
   ```

2. **Configure Environment Variables**:
   By default, the server runs on port `3456` with a maximum message size of `2000` characters. You can override these by creating an environment file or passing them in:
   | Variable | Default | Description |
   |----------|---------|-------------|
   | `PORT` | `3456` | HTTP server port |
   | `MAX_MESSAGE_LENGTH` | `2000` | Maximum characters per message |

---

## 🚀 Run & Quick Start

Start the Express and Socket.IO server:
```bash
npm start
```

For rapid development with auto-rebuild and live-reload:
```bash
npm run dev
```

Open `http://localhost:3456` in your web browser.

---

## 🛡️ Security & Architecture Best Practices

1. **State Isolation**: Memory storage is utilized for active users, messages, and room credentials, eliminating direct local file exposure.
2. **Access Control**: Password hashing is conducted for protected rooms, ensuring restricted access to authorized users only.
3. **Session Resiliency**: Gracefully handles network failures, featuring automatic Socket.IO reconnection mechanisms and session restoration routines.
4. **Accessibility (A11y)**: Fully compliant with WAI-ARIA standards, including ARIA labels, roles, and focus indicator outlines for screen readers.

---

## 🤝 Contributing & Support

### Contributions
This application is part of the **CSE 503S: Rapid Prototyping and Creative Programming** workspace at Washington University in St. Louis. Issues and PRs are welcome!

---

## 📄 License

Distributed under the **ISC License**. See `package.json` for details.
