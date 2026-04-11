const request = require('supertest');
const { app, serviceState, userSockets, processNotification } = require('./server');

const mockRedis = {
  lPush: jest.fn().mockResolvedValue(1),
  lTrim: jest.fn().mockResolvedValue('OK'),
  lRange: jest.fn().mockResolvedValue([]),
  del: jest.fn().mockResolvedValue(1),
  rPush: jest.fn().mockResolvedValue(1),
};

// Inject mock correctly
serviceState.redisClient = mockRedis;

describe('Notification Service API', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    userSockets.clear();
  });

  test('GET / should return service status', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toEqual(200);
  });

  test('POST /notify should succeed with user_id', async () => {
    const res = await request(app)
      .post('/notify')
      .send({ user_id: '123', content: 'test' });
    
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.lPush).toHaveBeenCalled();
  });

  test('GET /notifications/:userId should handle errors', async () => {
    mockRedis.lRange.mockRejectedValueOnce(new Error('Redis Down'));
    const res = await request(app).get('/notifications/123');
    expect(res.statusCode).toEqual(500);
  });

  test('processNotification should generate ID if missing', async () => {
    const payload = { user_id: '456' };
    const result = await processNotification(payload);
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
  });

  test('DELETE /notifications/:userId/:notifId should filter items', async () => {
    mockRedis.lRange.mockResolvedValue([
        JSON.stringify({id: 'keep', user_id: '1'}),
        JSON.stringify({id: 'remove', user_id: '1'})
    ]);
    const res = await request(app).delete('/notifications/1/remove');
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.rPush).toHaveBeenCalled();
  });
});