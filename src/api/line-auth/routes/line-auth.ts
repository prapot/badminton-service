// LINE Login — the controller verifies the Strapi JWT itself where needed
export default {
  routes: [
    {
      method: 'POST',
      path: '/line-auth/login',
      handler: 'line-auth.login',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/line-auth/status',
      handler: 'line-auth.status',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/line-auth/link',
      handler: 'line-auth.link',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/line-auth/link-ticket',
      handler: 'line-auth.linkTicket',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/line-auth/register',
      handler: 'line-auth.register',
      config: {
        auth: false,
      },
    },
    {
      method: 'DELETE',
      path: '/line-auth/link',
      handler: 'line-auth.unlink',
      config: {
        auth: false,
      },
    },
  ],
};
