// import type { Core } from '@strapi/strapi';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   */
  bootstrap({ strapi }) {
    // Register global lifecycle for matches to ensure it works reliably in Strapi v5
    strapi.db.lifecycles.subscribe({
      models: ['api::match.match'],
      async afterUpdate(event) {
        const { result, params } = event;
        const documentId = result?.documentId || params?.where?.documentId;
        
        if (!documentId) return;

        try {
          // Fetch fresh data with deep population
          const match = await strapi.documents('api::match.match').findOne({
            documentId: documentId,
            populate: {
              tournament_id: true,
              team_a_id: { populate: { team_players: { populate: { user_id: true } } } },
              team_b_id: { populate: { team_players: { populate: { user_id: true } } } },
              team_winner: { populate: { team_players: { populate: { user_id: true } } } }
            }
          }) as any;

          if (!match) {
            console.log(`[Global Lifecycle] ERROR: Match ${documentId} not found during fetch.`);
            return;
          }

          console.log(`[Global Lifecycle] Checking Match: ${match.documentId}, Status: ${match.match_status}, Mode: ${match.tournament_id?.mode}`);

          if (match.match_status === 'done') {
            const isRankingMode = match.tournament_id?.mode === 'ranking';
            console.log(`[Global Lifecycle] PROCEEDING: Recording stats for Match ${match.documentId}. Ranking Mode: ${isRankingMode}`);
            
            // ALWAYS revert first to handle edits correctly
            await strapi.service('api::ranking.ranking').revertMatch(match.id);
            
            // Determine winner/loser
            const scoreA = Number(match.score_a || 0);
            const scoreB = Number(match.score_b || 0);
            console.log(`[Global Lifecycle] Scores - A: ${scoreA}, B: ${scoreB}`);
            
            if (scoreA === scoreB) {
                console.log(`[Global Lifecycle] DRAW: Skipping stats update.`);
                return;
            }

            let winnerTeam = match.team_winner;
            if (!winnerTeam || !winnerTeam.documentId) {
                winnerTeam = scoreA > scoreB ? match.team_a_id : match.team_b_id;
            }
            const isWinnerA = (winnerTeam?.documentId === match.team_a_id?.documentId);
            const loserTeam = isWinnerA ? match.team_b_id : match.team_a_id;

            console.log(`[Global Lifecycle] Winner Team: ${winnerTeam?.documentId}, Players Count: ${winnerTeam?.team_players?.length || 0}`);
            console.log(`[Global Lifecycle] Loser Team: ${loserTeam?.documentId}, Players Count: ${loserTeam?.team_players?.length || 0}`);

            const winners = (winnerTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []) as number[];
            const losers = (loserTeam?.team_players?.map(tp => tp.user_id?.id).filter(Boolean) || []) as number[];

            console.log(`[Global Lifecycle] Participants - Winners: [${winners}], Losers: [${losers}]`);

            if (winners.length > 0 && losers.length > 0) {
              await strapi.service('api::ranking.ranking').recordMatch(
                winners,
                losers,
                isWinnerA ? scoreA : scoreB,
                isWinnerA ? scoreB : scoreA,
                match.id,
                isRankingMode
              );
              console.log(`[Global Lifecycle] SUCCESS: Stats updated for match ${documentId}`);
            } else {
              console.log(`[Global Lifecycle] WARNING: No valid winners/losers found for match ${documentId}.`);
            }
          } else {
            console.log(`[Global Lifecycle] SKIPPING: Match status is '${match.match_status}', not 'done'.`);
          }
        } catch (err) {
          console.error(`[Global Lifecycle] Error:`, err);
        }
      },
    });
  },
};
