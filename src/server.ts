import { WebSocketServer, WebSocket } from "ws";

// Types for WebSocket messages
interface BaseMessage {
  type: string;
  data?: unknown;
}

interface CreateRoomMessage extends BaseMessage {
  type: "create_room";
}

interface JoinRoomMessage extends BaseMessage {
  type: "join_room";
  data: { roomCode: string };
}

interface ReconnectMessage extends BaseMessage {
  type: "reconnect";
  data: { roomCode: string; clientType: "host" | "player1" | "player2" };
}

type IncomingMessage = CreateRoomMessage | JoinRoomMessage | ReconnectMessage | BaseMessage;

// Player identification type
type PlayerSlot = "player1" | "player2";

// Room structure
interface Room {
  code: string;
  host: WebSocket | null;
  player1: WebSocket | null;
  player2: WebSocket | null;
  createdAt: number;
}

// Map to store active rooms
const rooms = new Map<string, Room>();

// Characters for room codes (avoiding ambiguous characters: 0/O, 1/I/L)
const ROOM_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 4;

// Generate a unique 4-character room code
function generateRoomCode(): string {
  let code: string;
  let attempts = 0;
  const maxAttempts = 100;

  do {
    code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS.charAt(
        Math.floor(Math.random() * ROOM_CODE_CHARS.length)
      );
    }
    attempts++;
  } while (rooms.has(code) && attempts < maxAttempts);

  if (attempts >= maxAttempts) {
    throw new Error("Failed to generate unique room code");
  }

  return code;
}

// Send a message to a WebSocket client
function sendMessage(ws: WebSocket, type: string, data?: unknown): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

// Clean up a room when host disconnects
function cleanupRoom(roomCode: string): void {
  const room = rooms.get(roomCode);
  if (room) {
    // Notify players if connected
    if (room.player1 && room.player1.readyState === WebSocket.OPEN) {
      sendMessage(room.player1, "room_closed", {
        message: "Host disconnected",
      });
    }
    if (room.player2 && room.player2.readyState === WebSocket.OPEN) {
      sendMessage(room.player2, "room_closed", {
        message: "Host disconnected",
      });
    }
    rooms.delete(roomCode);
    console.log(`Room ${roomCode} cleaned up`);
  }
}

// Handle messages from host (game screen)
function handleHostMessage(
  ws: WebSocket,
  message: IncomingMessage,
  roomCode: string
): void {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Forward message to both players if connected
  if (room.player1 && room.player1.readyState === WebSocket.OPEN) {
    room.player1.send(JSON.stringify(message));
  }
  if (room.player2 && room.player2.readyState === WebSocket.OPEN) {
    room.player2.send(JSON.stringify(message));
  }
}

// Handle messages from player (controller)
function handlePlayerMessage(
  ws: WebSocket,
  message: IncomingMessage,
  roomCode: string,
  playerSlot: PlayerSlot
): void {
  const room = rooms.get(roomCode);
  if (!room) return;

  // Forward message to host with player identification
  if (room.host && room.host.readyState === WebSocket.OPEN) {
    const messageWithPlayer = {
      ...message,
      player: playerSlot,
    };
    room.host.send(JSON.stringify(messageWithPlayer));
  }
}

// Create WebSocket server
const PORT = parseInt(process.env.PORT || "3000", 10);
const wss = new WebSocketServer({ port: PORT });

console.log(`WebSocket server started on port ${PORT}`);

// Client info type
type ClientInfo =
  | { roomCode: string; role: "host" }
  | { roomCode: string; role: "player"; playerSlot: PlayerSlot };

// Store room code associated with each WebSocket connection
const clientRooms = new WeakMap<WebSocket, ClientInfo>();

wss.on("connection", (ws: WebSocket) => {
  console.log("New client connected");

  ws.on("message", (rawMessage: Buffer) => {
    let message: IncomingMessage;
    try {
      message = JSON.parse(rawMessage.toString()) as IncomingMessage;
    } catch {
      sendMessage(ws, "error", { message: "Invalid JSON" });
      return;
    }

    const clientInfo = clientRooms.get(ws);

    switch (message.type) {
      case "create_room": {
        // Game screen creates a new room
        const roomCode = generateRoomCode();
        const room: Room = {
          code: roomCode,
          host: ws,
          player1: null,
          player2: null,
          createdAt: Date.now(),
        };
        rooms.set(roomCode, room);
        clientRooms.set(ws, { roomCode, role: "host" });
        sendMessage(ws, "room_created", { roomCode });
        console.log(`Room ${roomCode} created`);
        break;
      }

      case "join_room": {
        // Controller joins an existing room
        const joinData = message.data as { roomCode: string };
        const roomCode = joinData?.roomCode?.toUpperCase();

        if (!roomCode) {
          sendMessage(ws, "error", { message: "Room code required" });
          return;
        }

        const room = rooms.get(roomCode);
        if (!room) {
          sendMessage(ws, "error", { message: "Room not found" });
          return;
        }

        // Determine which player slot to assign
        const player1Connected = room.player1 && room.player1.readyState === WebSocket.OPEN;
        const player2Connected = room.player2 && room.player2.readyState === WebSocket.OPEN;

        let assignedSlot: PlayerSlot;

        if (!player1Connected) {
          // First controller to join becomes player1 (left paddle)
          assignedSlot = "player1";
          room.player1 = ws;
        } else if (!player2Connected) {
          // Second controller to join becomes player2 (right paddle)
          assignedSlot = "player2";
          room.player2 = ws;
        } else {
          sendMessage(ws, "error", { message: "Room is full" });
          return;
        }

        clientRooms.set(ws, { roomCode, role: "player", playerSlot: assignedSlot });
        sendMessage(ws, "room_joined", { roomCode, playerSlot: assignedSlot });

        // Notify host that player joined
        if (room.host && room.host.readyState === WebSocket.OPEN) {
          sendMessage(room.host, `${assignedSlot}_joined`, {});
        }

        console.log(`${assignedSlot} joined room ${roomCode}`);
        break;
      }

      case "reconnect": {
        // Handle reconnection
        const reconnectData = message.data as {
          roomCode: string;
          clientType: "host" | "player1" | "player2";
        };
        const roomCode = reconnectData?.roomCode?.toUpperCase();
        const clientType = reconnectData?.clientType;

        if (!roomCode) {
          sendMessage(ws, "error", { message: "Room code required" });
          return;
        }

        const room = rooms.get(roomCode);
        if (!room) {
          sendMessage(ws, "error", {
            message: "Room not found or expired",
          });
          return;
        }

        if (clientType === "host") {
          room.host = ws;
          clientRooms.set(ws, { roomCode, role: "host" });
          sendMessage(ws, "reconnected", { roomCode });

          // Notify players of host reconnection
          if (room.player1 && room.player1.readyState === WebSocket.OPEN) {
            sendMessage(room.player1, "peer_reconnected", {});
          }
          if (room.player2 && room.player2.readyState === WebSocket.OPEN) {
            sendMessage(room.player2, "peer_reconnected", {});
          }
        } else if (clientType === "player1") {
          room.player1 = ws;
          clientRooms.set(ws, { roomCode, role: "player", playerSlot: "player1" });
          sendMessage(ws, "reconnected", { roomCode, playerSlot: "player1" });

          // Notify host of player1 reconnection
          if (room.host && room.host.readyState === WebSocket.OPEN) {
            sendMessage(room.host, "player1_reconnected", {});
          }
        } else if (clientType === "player2") {
          room.player2 = ws;
          clientRooms.set(ws, { roomCode, role: "player", playerSlot: "player2" });
          sendMessage(ws, "reconnected", { roomCode, playerSlot: "player2" });

          // Notify host of player2 reconnection
          if (room.host && room.host.readyState === WebSocket.OPEN) {
            sendMessage(room.host, "player2_reconnected", {});
          }
        }

        console.log(`${clientType} reconnected to room ${roomCode}`);
        break;
      }

      default: {
        // Forward any other messages between host and players
        if (clientInfo) {
          if (clientInfo.role === "host") {
            handleHostMessage(ws, message, clientInfo.roomCode);
          } else {
            handlePlayerMessage(ws, message, clientInfo.roomCode, clientInfo.playerSlot);
          }
        }
        break;
      }
    }
  });

  ws.on("close", () => {
    const clientInfo = clientRooms.get(ws);
    if (clientInfo) {
      const room = rooms.get(clientInfo.roomCode);
      if (room) {
        if (clientInfo.role === "host") {
          // Host disconnected - clean up the room
          cleanupRoom(clientInfo.roomCode);
        } else {
          // Player disconnected - notify host but keep room
          const playerSlot = clientInfo.playerSlot;
          if (playerSlot === "player1") {
            room.player1 = null;
          } else {
            room.player2 = null;
          }
          if (room.host && room.host.readyState === WebSocket.OPEN) {
            sendMessage(room.host, `${playerSlot}_disconnected`, {});
          }
          console.log(`${playerSlot} disconnected from room ${clientInfo.roomCode}`);
        }
      }
    }
    console.log("Client disconnected");
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// Periodic cleanup of stale rooms (rooms older than 1 hour with no activity)
const ROOM_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const hasActiveHost =
      room.host && room.host.readyState === WebSocket.OPEN;
    const hasActivePlayer1 =
      room.player1 && room.player1.readyState === WebSocket.OPEN;
    const hasActivePlayer2 =
      room.player2 && room.player2.readyState === WebSocket.OPEN;

    // Clean up rooms that are too old and have no active connections
    if (!hasActiveHost && !hasActivePlayer1 && !hasActivePlayer2 && now - room.createdAt > ROOM_TIMEOUT_MS) {
      rooms.delete(code);
      console.log(`Stale room ${code} cleaned up`);
    }
  }
}, 5 * 60 * 1000); // Check every 5 minutes
