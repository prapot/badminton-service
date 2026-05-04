const strapi = require('@strapi/strapi');

async function testPopulate() {
    const app = await strapi().load();
    const matchId = 'u3y993952x1385i1k4w2yqck'; // Let's find the documentId of match 1149
    
    const matches = await app.db.query('api::match.match').findMany({
        where: { id: 1149 }
    });
    const docId = matches[0].documentId;
    console.log(`Document ID for match 1149: ${docId}`);
    
    const match = await app.documents('api::match.match').findOne({
        documentId: docId,
        populate: [
            'tournament_id',
            'team_a_id', 
            'team_b_id', 
            'team_winner',
            'team_a_id.team_players', 
            'team_b_id.team_players', 
            'team_a_id.team_players.user_id', 
            'team_b_id.team_players.user_id'
        ]
    });
    
    console.log(JSON.stringify(match, null, 2));
    process.exit(0);
}

testPopulate().catch(console.error);
