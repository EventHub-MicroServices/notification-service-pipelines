const request = require('supertest');
const { app, userSockets } = require('./server');

// Mock Redis
const mockRedis = {
  lPush: jest.fn().mockResolvedValue(1),
  lTrim: jest.fn().mockResolvedValue('OK'),
  lRange: jest.fn().mockResolvedValue([]),
  del: jest.fn().mockResolvedValue(1),
  rPush: jest.fn().mockResolvedValue(1),
};

// Inject the mock into the server's redisClient reference
// Note: In a real scenario, you'd use jest.mock('redis')
require('./server').redisClient = mockRedis;

describe('Notification Service API', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
    userSockets.clear();
  });

  test('GET / should return service status', async () => {
    const res = await request(app).get('/');
    expect(res.statusCode).toEqual(200);
    expect(res.body.service).toBe('notification-service');
  });

  test('POST /notify should fail without user_id', async () => {
    const res = await request(app)
      .post('/notify')
      .send({ message: 'hello' });
    expect(res.statusCode).toEqual(400);
  });

  test('POST /notify should succeed with user_id', async () => {
    const res = await request(app)
      .post('/notify')
      .send({ user_id: '123', message: 'hello' });
    
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.lPush).toHaveBeenCalled();
  });

  test('GET /notifications/:userId should return list', async () => {
    mockRedis.lRange.mockResolvedValue([JSON.stringify({ id: '1', message: 'test' })]);
    const res = await request(app).get('/notifications/123');
    
    expect(res.statusCode).toEqual(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe('1');
  });

  test('DELETE /notifications/user/:userId should clear all', async () => {
    const res = await request(app).delete('/notifications/user/123');
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.del).toHaveBeenCalledWith('notifications:123');
  });

  test('DELETE /notifications/:userId/:notifId should remove specific item', async () => {
    // Setup redis to have one item
    mockRedis.lRange.mockResolvedValue([JSON.stringify({ id: '99', user_id: '123' })]);
    
    const res = await request(app).delete('/notifications/123/99');
    expect(res.statusCode).toEqual(200);
    expect(mockRedis.del).toHaveBeenCalled();
  });
});