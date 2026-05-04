const strapi = require('@strapi/strapi');

async function test() {
    const app = await strapi().load();
    const matches = await app.db.query('api::match.match').findMany({
        where: { match_status: 'done' },
        orderBy: { updatedAt: 'desc' },
        limit: 5,
        populate: ['tournament_id', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id', 'team_winner']
    });
    
    for (const match of matches) {
        if (match.tournament_id?.mode !== 'ranking') continue;
        
        const historyCount = await app.db.query('api::match-history.match-history').count({
            where: { matches: match.id }
        });
        
        if (historyCount === 0) {
            console.log(`Missing stats for Match ID: ${match.id} (Document ID: ${match.documentId}). Recalculating...`);
            const winnerId = match.team_winner?.documentId || match.team_winner?.id;
            const isWinnerA = winnerId === (match.team_a_id?.documentId || match.team_a_id?.id);
            const winnerTeam = isWinnerA ? match.team_a_id : match.team_b_id;
            const loserTeam = isWinnerA ? match.team_b_id : match.team_a_id;

            const winners = winnerTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || [];
            const losers = loserTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || [];

            console.log(`Winners: ${winners.length}, Losers: ${losers.length}`);
            if (winners.length > 0 && losers.length > 0) {
                await app.service('api::ranking.ranking').recordMatch(
                    winners, losers, match.score_a, match.score_b, match.documentId
                );
                console.log(`  -> Fixed! Points and stars updated.`);
            }
        }
    }
    process.exit(0);
}
test().catch(console.error);
