const strapi = require('@strapi/strapi');

async function fixProductionScores() {
    const app = await strapi().load();
    console.log("🚀 Starting Production Score Recovery...");
    
    // Find all matches that are 'done'
    const matches = await app.db.query('api::match.match').findMany({
        where: { match_status: 'done' },
        orderBy: { updatedAt: 'asc' }, // Process oldest first to maintain chronological MMR
        populate: ['tournament_id', 'team_a_id.team_players.user_id', 'team_b_id.team_players.user_id', 'team_winner']
    });
    
    let fixedCount = 0;
    
    for (const match of matches) {
        // Skip casual mode
        if (match.tournament_id?.mode !== 'ranking') continue;
        
        // Check if stats are already recorded
        const historyCount = await app.db.query('api::match-history.match-history').count({
            where: { matches: match.id }
        });
        
        if (historyCount === 0) {
            console.log(`[Missing Stats] Match ID: ${match.id} (Doc: ${match.documentId}). Recovering...`);
            
            const winnerId = match.team_winner?.documentId || match.team_winner?.id;
            const isWinnerA = winnerId === (match.team_a_id?.documentId || match.team_a_id?.id);
            const winnerTeam = isWinnerA ? match.team_a_id : match.team_b_id;
            const loserTeam = isWinnerA ? match.team_b_id : match.team_a_id;

            // Use Set to remove any duplicate players caused by Strapi drafts
            const winners = Array.from(new Set(winnerTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));
            const losers = Array.from(new Set(loserTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));

            if (winners.length > 0 && losers.length > 0) {
                await app.service('api::ranking.ranking').recordMatch(
                    winners, losers, match.score_a, match.score_b, match.documentId
                );
                console.log(`  ✅ Recovered! Points and stars updated for ${winners.length} winners and ${losers.length} losers.`);
                fixedCount++;
            } else {
                console.log(`  ⚠️ Skipped: Could not resolve players. (Winners: ${winners.length}, Losers: ${losers.length})`);
            }
        }
    }
    
    console.log(`\n🎉 Recovery Complete! Successfully fixed ${fixedCount} matches.`);
    process.exit(0);
}

fixProductionScores().catch(console.error);
