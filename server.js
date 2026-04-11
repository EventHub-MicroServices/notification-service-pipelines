const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const amqplib = require('amqplib');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 8006;
const REDIS_URL = process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'notification-redis'}:${process.env.REDIS_PORT || '6379'}`;
const RABBITMQ_URL = process.env.RABBITMQ_URL || `amqp://${process.env.RABBITMQ_USER || 'guest'}:${process.env.RABBITMQ_PASSWORD || 'guest'}@${process.env.RABBITMQ_HOST || 'rabbitmq'}:${process.env.RABBITMQ_PORT || '5672'}/`;

let redisClient;
let amqpChannel;
const userSockets = new Map();

/**
 * SHARED LOGIC: Enriches notification, saves to Redis, and emits to Socket
 */
async function processNotification(payload, source = "Unknown") {
  if (!payload.user_id) return;

  // 1. Enrich data
  if (!payload.id) payload.id = Date.now().toString() + Math.random().toString(36).substring(2, 7);
  if (!payload.created_at) payload.created_at = new Date().toISOString();

  console.log(`Processing notification from ${source}:`, payload.id);

  // 2. Persist to Redis
  const redisKey = `notifications:${payload.user_id}`;
  await redisClient.lPush(redisKey, JSON.stringify(payload));
  await redisClient.lTrim(redisKey, 0, 49);

  // 3. Real-time push
  const socketId = userSockets.get(String(payload.user_id));
  if (socketId) {
    io.to(socketId).emit('notification', payload);
  }
}

async function init() {
  try {
    redisClient = createClient({ url: REDIS_URL });
    redisClient.on('error', (err) => console.log('Redis Client Error', err));
    await redisClient.connect();

    const conn = await amqplib.connect(RABBITMQ_URL);
    amqpChannel = await conn.createChannel();
    await amqpChannel.assertExchange('notifications', 'fanout', { durable: false });
    const q = await amqpChannel.assertQueue('', { exclusive: true });
    await amqpChannel.bindQueue(q.queue, 'notifications', '');

    // Refactored RabbitMQ Consumer
    amqpChannel.consume(q.queue, async (msg) => {
      if (msg.content) {
        const payload = JSON.parse(msg.content.toString());
        await processNotification(payload, "RabbitMQ");
      }
    }, { noAck: true });

    console.log('Connected to Redis & RabbitMQ');
  } catch (error) {
    console.error('Initialization error:', error);
  }
}

io.on('connection', (socket) => {
  socket.on('register', (userId) => userSockets.set(String(userId), socket.id));
  socket.on('disconnect', () => {
    for (const [userId, sockId] of userSockets.entries()) {
      if (sockId === socket.id) {
        userSockets.delete(userId);
        break;
      }
    }
  });
});

// Refactored HTTP Endpoint
app.post('/notify', async (req, res) => {
  try {
    if (!req.body.user_id) return res.status(400).json({ error: "user_id required" });
    await processNotification(req.body, "HTTP");
    res.json({ status: "SENT" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Other endpoints remain largely the same...
app.get('/', (req, res) => res.send({ service: 'notification-service', status: 'running' }));

app.get('/notifications/:userId', async (req, res) => {
  const list = await redisClient.lRange(`notifications:${req.params.userId}`, 0, -1);
  res.json(list.map(s => JSON.parse(s)));
});

// Start
init().then(() => {
  server.listen(PORT, () => console.log(`Listening on ${PORT}`));
});