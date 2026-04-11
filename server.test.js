const { processNotification } = require('./app');

describe('Notification Logic', () => {
  it('should enrich notification with UUID and timestamp', async () => {
    // Mock dependencies
    const mockRedis = { lPush: jest.fn(), lTrim: jest.fn() };
    const mockIo = { to: jest.fn().mockReturnThis(), emit: jest.fn() };
    const mockMap = new Map();

    const payload = { user_id: '123', message: 'Hello' };
    
    await processNotification(payload, 'Test', {
      redis: mockRedis,
      socketIo: mockIo,
      socketsMap: mockMap
    });

    expect(payload.id).toBeDefined();
    expect(payload.created_at).toBeDefined();
    expect(mockRedis.lPush).toHaveBeenCalled();
  });
});