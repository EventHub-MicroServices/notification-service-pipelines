// --- Move logic into an exported object or separate functions ---
const express = require('express');
const http = require('node:http');
const { Server } = require('socket.io');
const { createClient } = require('redis');
const amqplib = require('amqplib');
const cors = require('cors');
const crypto = require('node:crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// State
const userSockets = new Map();
let redisClient;
let amqpChannel;

/**
 * Logic extracted for unit testing
 */
async function processNotification(payload, source = "Unknown", deps = {}) {
  const { redis, socketIo, socketsMap } = deps;
  if (!payload.user_id) return;

  if (!payload.id) payload.id = crypto.randomUUID();
  if (!payload.created_at) payload.created_at = new Date().toISOString();

  const safeUserId = String(payload.user_id).replace(/[^\w-]/g, '');
  console.log(`Notification processed. Source: ${source} | Target User: ${safeUserId}`);

  const redisKey = `notifications:${payload.user_id}`;
  await redis.lPush(redisKey, JSON.stringify(payload));
  await redis.lTrim(redisKey, 0, 49);

  const socketId = socketsMap.get(String(payload.user_id));
  if (socketId) {
    socketIo.to(socketId).emit('notification', payload);
  }
}

// ... Routes ...
app.post('/notify', async (req, res) => {
  try {
    if (!req.body.user_id) return res.status(400).json({ error: "user_id required" });
    // Inject dependencies
    await processNotification(req.body, "HTTP", { 
        redis: redisClient, 
        socketIo: io, 
        socketsMap: userSockets 
    });
    res.json({ status: "SENT" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// IMPORTANT: Export everything so the test file can see it
module.exports = { app, processNotification, userSockets, server };

// Only start the server if this file is run directly (not required by tests)
if (require.main === module) {
    const PORT = process.env.PORT || 8006;
    // ... init() logic and server.listen here ...
}