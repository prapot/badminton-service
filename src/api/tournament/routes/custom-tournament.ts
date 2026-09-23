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
    {
      method: 'GET',
      path: '/tournaments/:id/my-blocked-partner',
      handler: 'custom-tournament.getMyBlockedPartner',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/tournaments/:id/blocked-partner',
      handler: 'custom-tournament.setBlockedPartner',
      config: {
        auth: false,
      },
    },
    {
      method: 'DELETE',
      path: '/tournaments/:id/blocked-partner',
      handler: 'custom-tournament.removeBlockedPartner',
      config: {
        auth: false,
      },
    },
  ],
};
