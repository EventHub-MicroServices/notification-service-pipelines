const express = require('express');
const http = require('node:http');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const amqplib = require('amqplib');
const cors = require('cors');
const helmet = require('helmet');

const app = express();

app.use(helmet());
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

// SonarQube: Grouping state to allow easier testing/mocking
const serviceState = {
  redisClient: null,
  amqpChannel: null
};

const userSockets = new Map();

async function processNotification(payload) {
  const data = { ...payload };
  
  if (!data.id) {
    data.id = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  }
  if (!data.created_at) {
    data.created_at = new Date().toISOString();
  }

  const redisKey = `notifications:${data.user_id}`;
  
  // Use the serviceState reference
  if (serviceState.redisClient) {
    await serviceState.redisClient.lPush(redisKey, JSON.stringify(data));
    await serviceState.redisClient.lTrim(redisKey, 0, 49);
  }

  const socketId = userSockets.get(String(data.user_id));
  if (socketId) {
    io.to(socketId).emit('notification', data);
  }
  
  return data;
}

async function init() {
  try {
    serviceState.redisClient = createClient({ url: REDIS_URL });
    serviceState.redisClient.on('error', (err) => console.error('Redis Client Error', err));
    await serviceState.redisClient.connect();

    const conn = await amqplib.connect(RABBITMQ_URL);
    serviceState.amqpChannel = await conn.createChannel();
    await serviceState.amqpChannel.assertExchange('notifications', 'fanout', { durable: false });
    const q = await serviceState.amqpChannel.assertQueue('', { exclusive: true });
    await serviceState.amqpChannel.bindQueue(q.queue, 'notifications', '');

    serviceState.amqpChannel.consume(q.queue, async (msg) => {
      if (msg?.content) {
        try {
          const payload = JSON.parse(msg.content.toString());
          await processNotification(payload);
        } catch (parseErr) {
          console.error("Failed to parse RabbitMQ message content:", parseErr);
        }
      }
    }, { noAck: true });

  } catch (error) {
    console.error('Initialization error:', error);
    if (require.main === module) process.exit(1);
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

app.post('/notify', async (req, res) => {
  try {
    const payload = req.body;
    if (!payload.user_id) {
      return res.status(400).json({ error: "user_id required" });
    }
    
    const processed = await processNotification(payload);
    return res.json({ status: "SENT", id: processed.id });
  } catch (e) {
    console.error("HTTP notify error:", e);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.get('/', (_req, res) => {
  res.send({ service: 'notification-service', status: 'running' });
});

app.get('/notifications/:userId', async (req, res) => {
  try {
    const list = await serviceState.redisClient.lRange(`notifications:${req.params.userId}`, 0, -1);
    const notifications = list.map(item => JSON.parse(item));
    res.json(notifications);
  } catch (e) {
    console.error("Fetch notifications error:", e);
    res.status(500).json({ error: "Failed to fetch notifications" });
  }
});

app.delete('/notifications/user/:userId', async (req, res) => {
  try {
    await serviceState.redisClient.del(`notifications:${req.params.userId}`);
    res.json({ message: 'Notifications cleared' });
  } catch (e) {
    console.error("Clear notifications error:", e);
    res.status(500).json({ error: "Failed to delete notifications" });
  }
});

app.delete('/notifications/:userId/:notifId', async (req, res) => {
  try {
    const { userId, notifId } = req.params;
    const redisKey = `notifications:${userId}`;
    const list = await serviceState.redisClient.lRange(redisKey, 0, -1);
    
    const remaining = list.filter(itemStr => {
      try {
        const item = JSON.parse(itemStr);
        return item.id !== notifId;
      } catch (parseErr) {
        console.error("Parsing error during filtration:", parseErr);
        return true;
      }
    });
    
    await serviceState.redisClient.del(redisKey);
    
    if (remaining.length > 0) {
      await serviceState.redisClient.rPush(redisKey, remaining);
    }
    res.json({ message: 'Notification removed' });
  } catch (e) {
    console.error("Delete single notification error:", e);
    res.status(500).json({ error: "Deletion error" });
  }
});

if (require.main === module) {
  init().then(() => {
    server.listen(PORT, () => {
      console.log(`Notification Service listening on port ${PORT}`);
    });
  });
}

module.exports = { app, serviceState, userSockets, processNotification };