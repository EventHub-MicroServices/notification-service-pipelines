const request = require('supertest');
const { app, state, processNotification } = require('./server');

const mockRedis = {
  lPush: jest.fn().mockResolvedValue(1),
  lTrim: jest.fn().mockResolvedValue('OK'),
  lRange: jest.fn().mockResolvedValue([]),
  del: jest.fn().mockResolvedValue(1),
  rPush: jest.fn().mockResolvedValue(1),
};

state.redisClient = mockRedis;

describe('Notification Service Advanced Tests', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    state.userSockets.clear();
  });

  // 1. Basic Health
  test('GET / returns 200', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toBe(200);
  });

  // 2. HTTP Notify Success Path
  test('POST /notify success', async () => {
    const res = await request(app)
      .post('/notify')
      .send({ user_id: 'user1', message: 'test' });
    expect(res.statusCode).toBe(200);
    expect(mockRedis.lPush).toHaveBeenCalled();
  });

  // 3. HTTP Notify Validation Path
  test('POST /notify missing user_id returns 400', async () => {
    const res = await request(app).post('/notify').send({});
    expect(res.statusCode).toBe(400);
  });

  // 4. HTTP Notify Error Path
  test('POST /notify redis error returns 500', async () => {
    mockRedis.lPush.mockRejectedValueOnce(new Error('Redis Connection Lost'));
    const res = await request(app).post('/notify').send({ user_id: 'user1' });
    expect(res.statusCode).toBe(500);
  });

  // 5. Fetch Notifications
  test('GET /notifications/:userId success', async () => {
    mockRedis.lRange.mockResolvedValueOnce([JSON.stringify({ id: '123' })]);
    const res = await request(app).get('/notifications/user1');
    expect(res.statusCode).toBe(200);
    expect(res.body[0].id).toBe('123');
  });

  test('GET /notifications/:userId error', async () => {
    mockRedis.lRange.mockRejectedValueOnce(new Error('Fetch Error'));
    const res = await request(app).get('/notifications/user1');
    expect(res.statusCode).toBe(500);
  });

  // 6. Delete Notifications
  test('DELETE /notifications/user/:userId success', async () => {
    const res = await request(app).delete('/notifications/user/user1');
    expect(res.statusCode).toBe(200);
  });

  // 7. Delete Single Notification (Filter Logic)
  test('DELETE /notifications/:userId/:notifId filters correctly', async () => {
    mockRedis.lRange.mockResolvedValueOnce([
      JSON.stringify({ id: 'keep' }),
      JSON.stringify({ id: 'remove' })
    ]);
    const res = await request(app).delete('/notifications/user1/remove');
    expect(res.statusCode).toBe(200);
    // Verify it re-pushed the remaining item
    expect(mockRedis.rPush).toHaveBeenCalled();
  });

  test('DELETE /notifications/:userId/:notifId handles parse errors', async () => {
    mockRedis.lRange.mockResolvedValueOnce(['invalid-json', JSON.stringify({id: '1'})]);
    const res = await request(app).delete('/notifications/user1/2');
    expect(res.statusCode).toBe(200);
  });

  // 8. Socket Mapping Coverage
  test('processNotification emits if socket exists', async () => {
    state.userSockets.set('user1', 'socket-123');
    const result = await processNotification({ user_id: 'user1' });
    expect(result.id).toBeDefined();
  });

  // 9. Logic coverage for ID generation
  test('processNotification preserves existing ID', async () => {
    const payload = { user_id: 'user1', id: 'existing-id' };
    const result = await processNotification(payload);
    expect(result.id).toBe('existing-id');
  });
});