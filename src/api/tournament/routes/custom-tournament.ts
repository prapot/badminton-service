export default {
  routes: [
    {
      method: 'POST',
      path: '/tournaments/:id/draw-next',
      handler: 'custom-tournament.drawNext',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/tournaments/:id/create-endless-match',
      handler: 'custom-tournament.createEndlessMatch',
      config: {
        auth: false,
      },
    },
  ],
};
