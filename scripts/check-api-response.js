
async function run() {
  try {
    const match = await strapi.documents('api::match.match').findFirst({
        filters: { tournament_id: { documentId: 'kfiih2oo59t76va22k11xrru' } },
        populate: {
            team_a_id: { populate: { team_players: { populate: { user_id: { populate: { rankings: { filters: { season: { is_active: true } } } } } } } } }
        }
    }) as any;

    if (!match) {
        console.log('Match not found for this tournament.');
        process.exit(0);
    }

    console.log('--- API DEBUG: MATCH PLAYER RANKINGS ---');
    const player = match.team_a_id?.team_players?.[0]?.user_id;
    if (player) {
        console.log(`User: ${player.username}`);
        console.log(`Rankings Found: ${player.rankings?.length}`);
        player.rankings?.forEach((r: any) => {
            console.log(`- Win: ${r.win}, Lose: ${r.lose}, RP: ${r.ranking_points}`);
        });
    } else {
        console.log('No players found in team_a');
    }
    console.log('---------------------------------------');

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

run();
