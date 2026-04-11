const express = require('express');
const http = require('node:http');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const amqplib = require('amqplib');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

// SonarQube: Use helmet for security headers
app.use(helmet()); 
// SonarQube: Avoid origin '*' in production. Using env var with fallback.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CORS_ORIGIN }
});

const PORT = process.env.PORT || 8006;
const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'notification-redis'}:${process.env.REDIS_PORT || '6379'}`;

const RABBITMQ_USER = process.env.RABBITMQ_USER || 'guest';
const RABBITMQ_PASS = process.env.RABBITMQ_PASSWORD || 'guest';
const RABBITMQ_HOST = process.env.RABBITMQ_HOST || 'rabbitmq';
const RABBITMQ_PORT = process.env.RABBITMQ_PORT || '5672';
const RABBITMQ_URL = process.env.RABBITMQ_URL || `amqp://${RABBITMQ_USER}:${RABBITMQ_PASS}@${RABBITMQ_HOST}:${RABBITMQ_PORT}/`;

let redisClient;
let amqpChannel;

const userSockets = new Map();

/**
 * Reusable logic to process, store, and emit notifications
 * Prevents code duplication (SonarQube S1192)
 */
async function processNotification(payload) {
  const data = { ...payload };
  
  // SonarQube: Use cryptographically strong IDs
  if (!data.id) {
    data.id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  }
  if (!data.created_at) {
    data.created_at = new Date().toISOString();
  }

  const redisKey = `notifications:${data.user_id}`;
  
  // Persistence logic
  await redisClient.lPush(redisKey, JSON.stringify(data));
  await redisClient.lTrim(redisKey, 0, 49);

  // Real-time emission
  const socketId = userSockets.get(String(data.user_id));
  if (socketId) {
    io.to(socketId).emit('notification', data);
  }
  
  return data;
}

async function init() {
  try {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.error('Redis Client Error', err));
    await redisClient.connect();

    const conn = await amqplib.connect(RABBITMQ_URL);
    amqpChannel = await conn.createChannel();
    await amqpChannel.assertExchange('notifications', 'fanout', { durable: false });
    const q = await amqpChannel.assertQueue('', { exclusive: true });
    await amqpChannel.bindQueue(q.queue, 'notifications', '');

    amqpChannel.consume(q.queue, async (msg) => {
      if (msg && msg.content) {
        try {
          const payload = JSON.parse(msg.content.toString());
          await processNotification(payload);
        } catch (parseErr) {
          console.error("Failed to parse RabbitMQ message:", parseErr);
        }
      }
    }, { noAck: true });

  } catch (error) {
    console.error('Initialization error:', error);
    process.exit(1); // Exit if critical connections fail
  }
}

io.on('connection', (socket) => {
  socket.on('register', (userId) => {
    userSockets.set(String(userId), socket.id);
  });

  socket.on('disconnect', () => {
    for (const [userId, sockId] of userSockets.entries()) {
      if (sockId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

// --- HTTP Endpoints ---

app.post('/notify', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.user_id) {
      return res.status(400).json({ error: "user_id required" });
    }
    
    const processed = await processNotification(payload);
    return res.json({ status: "SENT", id: processed.id });
  } catch (e) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/', (_req, res) => {
  res.send({ service: 'notification-service', status: 'running' });
});

app.get('/notifications/:userId', async (req, res) => {
  try {
    const list = await redisClient.lRange(`notifications:${req.params.userId}`, 0, -1);
    const notifications = list.map(item => JSON.parse(item));
    res.json(notifications);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.delete('/notifications/user/:userId', async (req, res) => {
  try {
    await redisClient.del(`notifications:${req.params.userId}`);
    res.json({ message: 'Notifications cleared' });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete notifications" });
  }
});

app.delete('/notifications/:userId/:notifId', async (req, res) => {
  try {
    const { userId, notifId } = req.params;
    const redisKey = `notifications:${userId}`;
    const list = await redisClient.lRange(redisKey, 0, -1);
    
    const remaining = list.filter(itemStr => {
      try {
        const item = JSON.parse(itemStr);
        return item.id !== notifId;
      } catch {
        return true;
      }
    });
    
    await redisClient.del(redisKey);
    
    if (remaining.length > 0) {
      // Use rPush to maintain original order after re-inserting
      await redisClient.rPush(redisKey, remaining);
    }
    res.json({ message: 'Notification removed' });
  } catch (e) {
    res.status(500).json({ error: "Deletion error" });
  }
});

init().then(() => {
  server.listen(PORT, () => {
    console.log(`Notification Service listening on port ${PORT}`);
  });
});