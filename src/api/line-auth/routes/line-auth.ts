// LINE Login — the controller verifies the Strapi JWT itself where needed
export default {
  routes: [
    {
      method: 'POST',
      path: '/line-auth/start',
      handler: 'line-auth.start',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/line-auth/callback',
      handler: 'line-auth.callback',
      config: {
        auth: false,
      },
    },
    {
      method: 'POST',
      path: '/line-auth/handoff',
      handler: 'line-auth.publishHandoff',
      config: {
        auth: false,
      },
    },
    {
      method: 'GET',
      path: '/line-auth/handoff/:id',
      handler: 'line-auth.claimHandoff',
      config: {
        auth: false,
      },
    },
    // legacy: browser-held state (pre-/start frontends) — remove once no client calls it
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
