import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from 'redis';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: [
      process.env.FRONTEND_URL || 'http://localhost:3000',
      'http://localhost:5173', // Vite default
      'http://localhost:3000', // React default
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  transports: ['websocket', 'polling'],
});

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:3000',
  ],
  credentials: true,
}));
app.use(express.json({ limit: '50mb' }));

// In-memory storage
const activeSessions = new Map();
const canvasData = new Map();

// Redis (optional, for scaling)
let redis = null;
const initRedis = async () => {
  try {
    redis = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      socket: {
        reconnectStrategy: (retries) => {
          if (retries > 10) return new Error('Max retries reached');
          return Math.min(retries * 100, 3000);
        }
      }
    });
    
    redis.on('error', (err) => {
      console.log('⚠️  Redis connection error:', err.message);
      redis = null;
    });

    await redis.connect();
    console.log('✅ Redis connected');
  } catch (err) {
    console.log('⚠️  Redis not available - running in memory mode');
    redis = null;
  }
};

initRedis();

// ============================================
// REST ENDPOINTS
// ============================================

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    redis: redis ? 'connected' : 'offline',
  });
});

app.get('/api/canvas/:id', (req, res) => {
  const { id } = req.params;
  const canvas = canvasData.get(id) || { strokes: [] };
  res.json({ success: true, canvas });
});

app.post('/api/canvas', (req, res) => {
  const { name, ownerId } = req.body;
  const canvasId = `canvas_${Date.now()}`;

  canvasData.set(canvasId, {
    id: canvasId,
    name: name || 'Untitled Canvas',
    strokes: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  res.json({
    success: true,
    canvas: canvasData.get(canvasId),
  });
});

// ============================================
// SOCKET.IO EVENTS
// ============================================

io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  socket.on('join_canvas', (data) => {
    const { canvasId, userId, username, color } = data;

    socket.join(`canvas:${canvasId}`);

    const session = {
      userId,
      socketId: socket.id,
      username,
      color,
      cursorX: 0,
      cursorY: 0,
    };

    activeSessions.set(socket.id, { ...session, canvasId });

    // Send active users to joiner
    const users = Array.from(activeSessions.values())
      .filter((s) => s.canvasId === canvasId)
      .map(({ canvasId, ...rest }) => rest);

    socket.emit('active_users', users);

    // Notify others
    socket.to(`canvas:${canvasId}`).emit('user_joined', session);

    console.log(
      `👤 ${username} joined canvas ${canvasId} (Total: ${users.length})`
    );
  });

  socket.on('draw_stroke', (data) => {
    const { canvasId, stroke } = data;

    // Store stroke
    if (!canvasData.has(canvasId)) {
      canvasData.set(canvasId, { strokes: [] });
    }
    canvasData.get(canvasId).strokes.push(stroke);

    // Broadcast to all in canvas
    socket.to(`canvas:${canvasId}`).emit('draw_stroke', stroke);
  });

  socket.on('cursor_move', (data) => {
    const { canvasId, x, y } = data;
    const session = activeSessions.get(socket.id);

    if (session) {
      socket.to(`canvas:${canvasId}`).emit('cursor_move', {
        userId: session.userId,
        x,
        y,
      });
    }
  });

  socket.on('leave_canvas', (data) => {
    const { canvasId } = data;
    const session = activeSessions.get(socket.id);

    if (session) {
      socket.leave(`canvas:${canvasId}`);
      socket.to(`canvas:${canvasId}`).emit('user_left', {
        userId: session.userId,
      });
      activeSessions.delete(socket.id);
      console.log(`❌ ${session.username} left canvas ${canvasId}`);
    }
  });

  socket.on('disconnect', () => {
    const session = activeSessions.get(socket.id);
    if (session) {
      console.log(`✗ ${session.username} disconnected`);
      activeSessions.delete(socket.id);
    }
  });
});

// ============================================
// START SERVER
// ============================================

const PORT = process.env.PORT || 4000;

httpServer.listen(PORT, () => {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🚀 UNIDRAW Backend Server`);
  console.log(`${'='.repeat(60)}`);
  console.log(`📍 Server: http://localhost:${PORT}`);
  console.log(`🌐 WebSocket: ws://localhost:${PORT}`);
  console.log(`🔌 CORS: ${process.env.FRONTEND_URL}`);
  console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  console.log(`${'='.repeat(60)}\n`);
});

export { app, io };