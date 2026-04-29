export default {
  routes: [
    {
      method: 'POST',
      path: '/tournaments/:id/draw-next',
      handler: 'custom-tournament.drawNext',
      config: {
        auth: false, // For now, or require auth if needed
      },
    },
  ],
};
