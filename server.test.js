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

describe('Notification Service API', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    state.userSockets.clear();
  });

  test('GET / should return 200', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toEqual(200);
  });

  test('POST /notify fails without user_id', async () => {
    const res = await request(app).post('/notify').send({ content: 'test' });
    expect(res.statusCode).toEqual(400);
  });

  test('POST /notify succeeds with user_id', async () => {
    const res = await request(app).post('/notify').send({ user_id: '123' });
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.lPush).toHaveBeenCalled();
  });

  test('POST /notify handles catch block gracefully', async () => {
    mockRedis.lPush.mockRejectedValueOnce(new Error('DB Down'));
    const res = await request(app).post('/notify').send({ user_id: '123' });
    expect(res.statusCode).toEqual(500);
  });

  test('GET /notifications/:userId succeeds', async () => {
    mockRedis.lRange.mockResolvedValueOnce([JSON.stringify({ id: '1' })]);
    const res = await request(app).get('/notifications/123');
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveLength(1);
  });

  test('GET /notifications/:userId handles error', async () => {
    mockRedis.lRange.mockRejectedValueOnce(new Error('DB Down'));
    const res = await request(app).get('/notifications/123');
    expect(res.statusCode).toEqual(500);
  });

  test('DELETE /notifications/user/:userId clears all', async () => {
    const res = await request(app).delete('/notifications/user/123');
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.del).toHaveBeenCalled();
  });

  test('DELETE /notifications/user/:userId handles error', async () => {
    mockRedis.del.mockRejectedValueOnce(new Error('DB Down'));
    const res = await request(app).delete('/notifications/user/123');
    expect(res.statusCode).toEqual(500);
  });

  test('DELETE /notifications/:userId/:notifId removes specific', async () => {
    mockRedis.lRange.mockResolvedValueOnce([
        JSON.stringify({id: 'keep'}),
        JSON.stringify({id: 'remove'})
    ]);
    const res = await request(app).delete('/notifications/1/remove');
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.rPush).toHaveBeenCalled();
  });

  test('DELETE /notifications/:userId/:notifId handles error', async () => {
    mockRedis.lRange.mockRejectedValueOnce(new Error('DB Down'));
    const res = await request(app).delete('/notifications/1/remove');
    expect(res.statusCode).toEqual(500);
  });

  test('processNotification assigns ID and timestamps', async () => {
    state.userSockets.set('456', 'mock-socket-id');
    const result = await processNotification({ user_id: '456' });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
  });
});