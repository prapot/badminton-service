const strapi = require('@strapi/strapi');

async function test() {
    const app = await strapi().load();
    const matchId = 1164; // One of the new matches
    
    const matches = await app.db.query('api::match.match').findMany({
        where: { id: matchId }
    });
    const docId = matches[0].documentId;
    console.log(`Document ID for match ${matchId}: ${docId}`);
    
    try {
        const match = await app.documents('api::match.match').findOne({
            documentId: docId,
            populate: {
                tournament_id: true,
                team_a_id: { populate: { team_players: { populate: { user_id: true } } } },
                team_b_id: { populate: { team_players: { populate: { user_id: true } } } },
                team_winner: true
            }
        });
        
        console.log(`Match fetched. tournament_mode: ${match.tournament_id?.mode}`);
        
        const winnerId = match.team_winner?.documentId;
        const winnerIdNum = match.team_winner?.id;
        
        console.log(`winnerId: ${winnerId}, winnerIdNum: ${winnerIdNum}`);
        console.log(`team_a_doc: ${match.team_a_id?.documentId}, team_a_id: ${match.team_a_id?.id}`);
        console.log(`team_b_doc: ${match.team_b_id?.documentId}, team_b_id: ${match.team_b_id?.id}`);

        const isWinnerA = (winnerId && winnerId === match.team_a_id?.documentId) || (winnerIdNum && winnerIdNum === match.team_a_id?.id);
        const winnerTeam = isWinnerA ? match.team_a_id : match.team_b_id;
        const loserTeam = isWinnerA ? match.team_b_id : match.team_a_id;

        console.log(`isWinnerA: ${isWinnerA}`);
        
        const winners = Array.from(new Set(winnerTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));
        const losers = Array.from(new Set(loserTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []));

        console.log(`Winners:`, winners);
        console.log(`Losers:`, losers);

    } catch (e) {
        console.error("ERROR:", e);
    }
    
    process.exit(0);
}
test().catch(console.error);
