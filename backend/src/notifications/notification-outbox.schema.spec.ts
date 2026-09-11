describe('NotificationOutbox schema contract', () => {
  it('exports the durable terminal-outcome model', async () => {
    const module = await import('./notification-outbox.schema.js').catch(
      () => ({ NotificationOutbox: undefined }),
    );

    expect(module.NotificationOutbox).toBeTypeOf('function');
  });
});
