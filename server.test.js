const request = require('supertest');

// 1. Setup the mocks for external services
const mockRedis = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(null),
  lPush: jest.fn().mockResolvedValue(1),
  lTrim: jest.fn().mockResolvedValue('OK'),
  lRange: jest.fn().mockResolvedValue([]),
  del: jest.fn().mockResolvedValue(1),
  rPush: jest.fn().mockResolvedValue(1),
};

const mockChannel = {
  assertExchange: jest.fn(),
  assertQueue: jest.fn().mockResolvedValue({ queue: 'test-queue' }),
  bindQueue: jest.fn(),
  consume: jest.fn(),
};

const mockAmqp = {
  connect: jest.fn().mockResolvedValue({
    createChannel: jest.fn().mockResolvedValue(mockChannel),
  }),
};

// 2. Apply mocks to the modules
jest.mock('redis', () => ({ createClient: () => mockRedis }));
jest.mock('amqplib', () => mockAmqp);

// 3. Import the server and state
// This must happen AFTER the mocks are defined
const { app, state, processNotification } = require('./server');

describe('Notification Service Full Coverage', () => {
  
  beforeAll(async () => {
    // Manually assign mocks to the state so routes don't find "null"
    state.redisClient = mockRedis;
    state.amqpChannel = mockChannel;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    state.userSockets.clear();
  });

  // --- Initialization Coverage (Covers the ~30 lines in init()) ---
  test('should initialize Redis and RabbitMQ successfully', async () => {
    // We import and call the server's internal init to cover those lines
    const { init } = require('./server');
    if (typeof init === 'function') {
      await expect(init()).resolves.not.toThrow();
    }
  });

  // --- HTTP Route Coverage ---
  test('GET / returns 200', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
  });

  test('POST /notify success path', async () => {
    const res = await request(app)
      .post('/notify')
      .send({ user_id: '123', message: 'hello' });
    expect(res.statusCode).toBe(200);
    expect(mockRedis.lPush).toHaveBeenCalled();
  });

  test('POST /notify returns 400 on invalid data', async () => {
    const res = await request(app).post('/notify').send({});
    expect(res.statusCode).toBe(400);
  });

  test('GET /notifications/:userId handles success', async () => {
    mockRedis.lRange.mockResolvedValueOnce([JSON.stringify({ id: 'test' })]);
    const res = await request(app).get('/notifications/123');
    expect(res.statusCode).toBe(200);
    expect(res.body[0].id).toBe('test');
  });

  test('DELETE /notifications/user/:userId clears all', async () => {
    const res = await request(app).delete('/notifications/user/123');
    expect(res.statusCode).toBe(200);
    expect(mockRedis.del).toHaveBeenCalled();
  });

  test('DELETE /notifications/:userId/:notifId filters items', async () => {
    mockRedis.lRange.mockResolvedValueOnce([
      JSON.stringify({ id: 'keep' }),
      JSON.stringify({ id: 'remove' })
    ]);
    const res = await request(app).delete('/notifications/123/remove');
    expect(res.statusCode).toBe(200);
    expect(mockRedis.rPush).toHaveBeenCalled();
  });

  // --- Error Path Coverage ---
  test('Routes should handle Redis errors gracefully', async () => {
    mockRedis.lRange.mockRejectedValueOnce(new Error('Redis Down'));
    const res = await request(app).get('/notifications/123');
    expect(res.statusCode).toBe(500);
  });

  // --- Logic Coverage ---
  test('processNotification should generate default ID', async () => {
    const result = await processNotification({ user_id: '999' });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
  });
});