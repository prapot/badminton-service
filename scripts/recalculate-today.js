const strapi = require('@strapi/strapi');

async function recalculate() {
    const app = await strapi().load();
    
    // Find all done matches
    const matches = await app.db.query('api::match.match').findMany({
        where: { match_status: 'done' },
        populate: ['tournament_id', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id', 'team_winner']
    });
    
    console.log(`Checking ${matches.length} finished matches for missing stats...`);
    let fixed = 0;
    
    for (const match of matches) {
        // Skip if not a ranking tournament
        if (match.tournament_id?.mode !== 'ranking') continue;
        
        // Check if history already exists
        const historyCount = await app.db.query('api::match-history.match-history').count({
            where: { matches: match.id }
        });
        
        if (historyCount === 0) {
            console.log(`Missing stats for Match ID: ${match.id} (Document ID: ${match.documentId}). Recalculating...`);
            
            // We can just call the service to record match
            const winnerId = match.team_winner?.documentId || match.team_winner?.id;
            if (!winnerId) {
                console.log(`  -> Skipped: No winner defined.`);
                continue;
            }

            const isWinnerA = winnerId === (match.team_a_id?.documentId || match.team_a_id?.id);
            const winnerTeam = isWinnerA ? match.team_a_id : match.team_b_id;
            const loserTeam = isWinnerA ? match.team_b_id : match.team_a_id;

            const winners = winnerTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || [];
            const losers = loserTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || [];

            const winnerScore = isWinnerA ? match.score_a : match.score_b;
            const loserScore = isWinnerA ? match.score_b : match.score_a;

            if (winners.length > 0 && losers.length > 0) {
                await app.service('api::ranking.ranking').recordMatch(
                    winners,
                    losers,
                    winnerScore,
                    loserScore,
                    match.documentId
                );
                console.log(`  -> Fixed! Points and stars updated.`);
                fixed++;
            } else {
                console.log(`  -> Skipped: Could not resolve players. Winners: ${winners.length}, Losers: ${losers.length}`);
            }
        }
    }
    
    console.log(`\nDone. Fixed stats for ${fixed} matches.`);
    process.exit(0);
}

recalculate().catch(console.error);
