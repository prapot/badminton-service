
const { createCoreService } = require('@strapi/strapi').factories;

async function checkMatches() {
  console.log("--- Checking Database Matches ---");
  
  // Find the latest knockout tournament
  const tournaments = await strapi.documents('api::tournament.tournament').findMany({
    filters: { format: 'knockout' },
    sort: { createdAt: 'desc' },
    limit: 1
  });

  if (tournaments.length === 0) {
    console.log("No knockout tournament found.");
    return;
  }

  const t = tournaments[0];
  console.log(`Tournament: ${t.title} (ID: ${t.id}, DocumentID: ${t.documentId})`);

  // Find all matches for this tournament
  const matches = await strapi.documents('api::match.match').findMany({
    filters: { tournament_id: { documentId: t.documentId } },
    populate: ['team_a_id', 'team_b_id', 'team_winner'],
    sort: [{ round: 'asc' }, { match_no: 'asc' }]
  });

  console.log(`Found ${matches.length} matches.`);

  matches.forEach(m => {
    console.log(`R${m.round} M${m.match_no}: [${m.match_status}] TeamA: ${m.team_a_id?.team_no || 'null'}, TeamB: ${m.team_b_id?.team_no || 'null'}, Winner: ${m.team_winner?.team_no || 'null'}`);
  });
}

checkMatches().then(() => process.exit(0)).catch(err => {
  console.error(err);
  process.exit(1);
});
