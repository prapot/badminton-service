const strapi = require('@strapi/strapi');

async function checkTodayMatches() {
    const app = await strapi().load();
    
    // Find all matches updated today
    const today = new Date();
    today.setHours(0,0,0,0);
    
    const matches = await app.db.query('api::match.match').findMany({
        where: {
            updatedAt: { $gte: today },
            match_status: 'done'
        },
        populate: ['tournament_id', 'team_winner', 'team_a_id.team_players', 'team_b_id.team_players']
    });
    
    console.log(`Found ${matches.length} finished matches today.`);
    
    for (const m of matches) {
        console.log(`Match ${m.id} | Tournament Mode: ${m.tournament_id?.mode} | Status: ${m.match_status} | Scores: ${m.score_a}-${m.score_b}`);
        
        // Check if history exists
        const history = await app.db.query('api::match-history.match-history').findMany({
            where: { matches: m.id },
            populate: ['users', 'ranking']
        });
        
        console.log(`  -> Generated ${history.length} match-history records.`);
    }
    
    // Check active season
    const activeSeason = await app.db.query('api::season.season').findOne({
        where: { is_active: true }
    });
    console.log(`\nActive Season: ${activeSeason?.name}`);
    
    // Check rankings created today
    const rankings = await app.db.query('api::ranking.ranking').findMany({
        where: { season: activeSeason?.id },
        populate: ['user_id']
    });
    console.log(`Rankings created for active season: ${rankings.length}`);
    
    process.exit(0);
}

checkTodayMatches().catch(console.error);
