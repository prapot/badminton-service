const { createStrapi } = require('@strapi/strapi');

async function runTest() {
  const app = createStrapi();
  await app.load();
  
  // Find a tournament to test with
  const tournaments = await app.db.query('api::tournament.tournament').findMany({ limit: 1 });
  if (tournaments.length === 0) {
    console.log("No tournaments found to test with.");
    process.exit(1);
  }
  const tournament = tournaments[0];
  const documentId = tournament.documentId;
  
  // Get some players
  const players = await app.db.query('api::tournament-player.tournament-player').findMany({
    where: { tournament_id: tournament.id },
    limit: 4,
    populate: ['user']
  });
  
  if (players.length < 4) {
    console.log("Not enough players in tournament to run test.");
    process.exit(1);
  }
  
  // Assuming player IDs are valid (either user.id or -player.id for guests)
  const getPid = (p) => p.user ? p.user.id : -p.id;
  
  const playerIdsA = [getPid(players[0]), getPid(players[1])];
  const playerIdsB = [getPid(players[2]), getPid(players[3])];
  
  console.log(`Testing concurrency on Tournament ID: ${documentId}`);
  console.log(`Team A IDs:`, playerIdsA);
  console.log(`Team B IDs:`, playerIdsB);
  
  const service = app.service('api::tournament.custom-tournament');
  
  console.log("Sending two createMatchManual requests simultaneously...");
  
  const request1 = service.createMatchManual(documentId, playerIdsA, playerIdsB).then(res => {
    console.log("Request 1 SUCCEEDED: Match created with ID", res.id);
  }).catch(err => {
    console.log("Request 1 FAILED:", err.message);
  });
  
  const request2 = service.createMatchManual(documentId, playerIdsA, playerIdsB).then(res => {
    console.log("Request 2 SUCCEEDED: Match created with ID", res.id);
  }).catch(err => {
    console.log("Request 2 FAILED:", err.message);
  });
  
  await Promise.allSettled([request1, request2]);
  
  // Cleanup test matches
  console.log("Cleaning up created matches...");
  const recentMatches = await app.db.query('api::match.match').findMany({
    where: { tournament_id: tournament.id },
    orderBy: { createdAt: 'desc' },
    limit: 2
  });
  // We can delete them if needed, but since it's a test db, maybe it's fine.
  
  console.log("Test finished.");
  process.exit(0);
}

runTest().catch(err => {
  console.error(err);
  process.exit(1);
});
