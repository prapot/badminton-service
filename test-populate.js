const strapi = require('@strapi/strapi');
strapi().start().then(async (app) => {
  const matches = await app.entityService.findMany('api::match.match', {
    filters: { match_status: 'upcoming' },
    populate: {
      team_a_id: { populate: { team_players: { populate: { user_id: true } } } },
      team_b_id: { populate: { team_players: { populate: { user_id: true } } } },
    },
    limit: 1
  });
  console.dir(matches, { depth: null });
  process.exit(0);
});
