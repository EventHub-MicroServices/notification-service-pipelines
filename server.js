const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const amqplib = require('amqplib');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 8006;

const REDIS_HOST = process.env.REDIS_HOST || 'notification-redis';
const REDIS_PORT = process.env.REDIS_PORT || '6379';
const REDIS_URL = process.env.REDIS_URL || `redis://${REDIS_HOST}:${REDIS_PORT}`;

const RABBITMQ_USER = process.env.RABBITMQ_USER || 'guest';
const RABBITMQ_PASSWORD = process.env.RABBITMQ_PASSWORD || 'guest';
const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'rabbitmq';
const RABBITMQ_PORT = process.env.RABBITMQ_PORT || '5672';
const RABBITMQ_URL = process.env.RABBITMQ_URL || `amqp://${RABBITMQ_USER}:${RABBITMQ_PASSWORD}@${RABBITMQ_HOST}:${RABBITMQ_PORT}/`;

let redisClient;
let amqpChannel;

// Store connected users mapping (user_id -> socket_id)
// In production, user Redis hash for scaled environments
const userSockets = new Map();

async function init() {
  try {
    // 1. Connect Redis
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.log('Redis Client Error', err));
    await redisClient.connect();
    console.log('Connected to Redis');

    // 2. Connect RabbitMQ
    const conn = await amqplib.connect(RABBITMQ_URL);
    amqpChannel = await conn.createChannel();
    await amqpChannel.assertExchange('notifications', 'fanout', { durable: false });
    const q = await amqpChannel.assertQueue('', { exclusive: true });
    await amqpChannel.bindQueue(q.queue, 'notifications', '');

    console.log('Connected to RabbitMQ, waiting for messages in %s', q.queue);

    // Consume messages from other microservices
    amqpChannel.consume(q.queue, async (msg) => {
      if (msg.content) {
        const payload = JSON.parse(msg.content.toString());
        
        // Add ID and Timestamp
        if (!payload.id) payload.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        if (!payload.created_at) payload.created_at = new Date().toISOString();
        
        console.log("Received notification request via RabbitMQ:", payload);
        
        // Save to Redis for history (Format: notifications:{userId} = List of JSON)
        await redisClient.lPush(`notifications:${payload.user_id}`, JSON.stringify(payload));
        // Keep only last 50
        await redisClient.lTrim(`notifications:${payload.user_id}`, 0, 49);

        // Push via Socket.io if user is connected
        const socketId = userSockets.get(String(payload.user_id));
        if (socketId) {
          io.to(socketId).emit('notification', payload);
          console.log(`Pushed to user ${payload.user_id}`);
        }
      }
    }, { noAck: true });

  } catch (error) {
    console.error('Initialization error:', error);
  }
}

// Socket.io connections from React Frontend
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', (userId) => {
    userSockets.set(String(userId), socket.id);
    console.log(`Registered user ${userId} to socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    // Remove from map
    for (const [userId, sockId] of userSockets.entries()) {
      if (sockId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

// HTTP Endpoints
app.post('/notify', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.user_id) return res.status(400).json({ error: "user_id required" });
    
    // Add ID and Timestamp
    if (!payload.id) payload.id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    if (!payload.created_at) payload.created_at = new Date().toISOString();

    console.log("Received notify HTTP request:", payload);
    
    // Save to Redis for history
    await redisClient.lPush(`notifications:${payload.user_id}`, JSON.stringify(payload));
    await redisClient.lTrim(`notifications:${payload.user_id}`, 0, 49);

    // Push via Socket.io if user is connected
    const socketId = userSockets.get(String(payload.user_id));
    if (socketId) {
      io.to(socketId).emit('notification', payload);
      console.log(`HTTP pushed to user ${payload.user_id}`);
    }
    res.json({ status: "SENT" });
  } catch (e) {
    console.error("HTTP notify error:", e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.send({ service: 'notification-service', status: 'running (NodeJS)' });
});

app.get('/notifications/:userId', async (req, res) => {
  try {
    const list = await redisClient.lRange(`notifications:${req.params.userId}`, 0, -1);
    res.json(list.map(s => JSON.parse(s)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/notifications/user/:userId', async (req, res) => {
  try {
    await redisClient.del(`notifications:${req.params.userId}`);
    res.json({ message: 'Notifications cleared' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/notifications/:userId/:notifId', async (req, res) => {
  try {
    const { userId, notifId } = req.params;
    const list = await redisClient.lRange(`notifications:${userId}`, 0, -1);
    
    const remaining = list.filter(itemStr => {
      try {
        const item = JSON.parse(itemStr);
        return item.id !== notifId;
      } catch (err) {
        return true;
      }
    });
    
    await redisClient.del(`notifications:${userId}`);
    
    if (remaining.length > 0) {
      // Re-push remaining in correct order (lpush from end of array to keep order matching lpush logic or rpush)
      // Since lRange returns [Newest, ..., Oldest], and we want Newest to be at index 0 after re-inserting,
      // we can rPush the array directly! rPush adds to the end, so index 0 = Newest, index N = Oldest.
      await redisClient.rPush(`notifications:${userId}`, remaining);
    }
    res.json({ message: 'Notification removed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Initialize and start
init().then(() => {
  server.listen(PORT, () => {
    console.log(`Notification Service listening on port ${PORT}`);
  });
});
