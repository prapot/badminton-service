
async function listTournaments() {
  const tournaments = await strapi.documents('api::tournament.tournament').findMany();
  console.log('Tournaments:', tournaments.map(t => ({ id: t.id, documentId: t.documentId, name: t.name, mode: t.mode })));
}

listTournaments();
