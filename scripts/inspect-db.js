
async function run() {
  try {
    const seasons = await strapi.db.query('api::season.season').findMany({
        orderBy: { updatedAt: 'desc' }
    });
    console.log('--- SEASONS IN DB ---');
    seasons.forEach(s => {
        console.log(`ID: ${s.id}, Name: ${s.name}, Active: ${s.is_active}, DocID: ${s.documentId}`);
    });

    const activeSeason = seasons.find(s => s.is_active);
    if (activeSeason) {
        const rankings = await strapi.db.query('api::ranking.ranking').findMany({
            where: { season: activeSeason.id },
            populate: ['user_id']
        });
        console.log(`--- RANKINGS FOR ACTIVE SEASON (${activeSeason.name}) ---`);
        rankings.forEach(r => {
            console.log(`User: ${r.user_id?.username}, RP: ${r.ranking_points}, W: ${r.win}, L: ${r.lose}`);
        });
    } else {
        console.log('!!! NO ACTIVE SEASON FOUND !!!');
    }

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
