
async function run() {
  try {
    const histories = await strapi.documents('api::match-history.match-history').findMany({
        limit: 5,
        sort: 'createdAt:desc',
        populate: { matches: true, ranking: { populate: { user_id: true } } }
    });
    
    console.log('--- LATEST MATCH HISTORIES ---');
    histories.forEach(h => {
        console.log(`ID: ${h.documentId}, Match: ${h.matches?.[0]?.documentId}, User: ${h.ranking?.user_id?.username}, RP Change: ${h.rp_change}, Win: ${h.is_win}`);
    });
    console.log('------------------------------');

    const rankings = await strapi.documents('api::ranking.ranking').findMany({
        limit: 5,
        sort: 'updatedAt:desc',
        populate: { user_id: true }
    });
    console.log('--- LATEST RANKING UPDATES ---');
    rankings.forEach(r => {
        console.log(`User: ${r.user_id?.username}, RP: ${r.ranking_points}, Win: ${r.win}, Lose: ${r.lose}`);
    });
    console.log('------------------------------');

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
