/**
 * custom-tournament service
 */

const drawingLocks = new Set<string>();

export default () => ({
  async drawNext(tournamentId: string, pairingMode: 'auto' | 'locked') {
    if (drawingLocks.has(tournamentId)) {
      throw new Error('ระบบกำลังประมวลผลการสุ่มแมตช์ กรุณารอสักครู่...');
    }
    drawingLocks.add(tournamentId);

    try {
      return await strapi.db.transaction(async ({ trx }) => {
        // 1. Fetch tournament by documentId
        const tournaments = (await strapi.entityService.findMany('api::tournament.tournament', {
          filters: { documentId: tournamentId },
          populate: '*',
          // @ts-ignore
          transaction: trx,
        } as any)) as any[];

        const tournament = tournaments[0];
        if (!tournament) {
          throw new Error('Tournament not found');
        }

        const tNumericId = tournament.id;

        const pPerTeam = tournament.type === 'double' ? 2 : 1;
        const permanentTeams = (tournament.permanent_teams as any[]) || [];

        // 2. Fetch tournament players (only those not paused)
        const tPlayers = (await strapi.db.query('api::tournament-player.tournament-player').findMany({
          where: { tournament_id: tNumericId },
          populate: ['user']
        })) as any[];

        // All players in tournament (to calculate effective counts properly)
        const allPlayers = tPlayers.map(tp => tp.user).filter(Boolean);
        const freePlayers = tPlayers.filter(tp => !tp.is_paused).map(tp => tp.user).filter(Boolean);
        const freePlayerIds = new Set(freePlayers.map(p => p.id));

        // 3. Fetch past matches
        const matches = (await strapi.db.query('api::match.match').findMany({
          where: { tournament_id: tNumericId },
          populate: {
            team_a_id: { populate: { team_players: { populate: { user_id: true } } } },
            team_b_id: { populate: { team_players: { populate: { user_id: true } } } },
          }
        })) as any[];

        // 4. Calculate stats
        const actualCounts = new Map<number, number>();
        const busy = new Set<number>();
        allPlayers.forEach(p => actualCounts.set(p.id, 0));

        matches.forEach(m => {
          if (m.match_status === 'cancelled') return;
          const pids = [
            ...(m.team_a_id?.team_players?.map((tp: any) => Number(tp.user_id?.id || tp.user_id)) || []),
            ...(m.team_b_id?.team_players?.map((tp: any) => Number(tp.user_id?.id || tp.user_id)) || [])
          ].filter((id) => !isNaN(id) && id > 0);

          pids.forEach(id => {
            if (actualCounts.has(id)) actualCounts.set(id, actualCounts.get(id)! + 1);
          });

          if (m.match_status === 'live' || m.match_status === 'upcoming') {
            pids.forEach(id => busy.add(id));
          }
        });

        const effectiveCounts = new Map(actualCounts);
        const playedCounts = Array.from(actualCounts.values()).filter(c => c > 0).sort((a, b) => a - b);
        if (playedCounts.length > 0) {
          const median = playedCounts[Math.floor(playedCounts.length / 2)];
          const mainGroup = playedCounts.filter(c => c >= median - 1);
          const minPlayed = mainGroup.length > 0 ? Math.min(...mainGroup) : median;

          allPlayers.forEach(p => {
            const actual = actualCounts.get(p.id) || 0;
            if (actual < minPlayed) {
              effectiveCounts.set(p.id, minPlayed);
            }
          });
        }

        // Filter free players who are also not busy
        const availablePlayers = freePlayers.filter(p => !busy.has(p.id));
        const availablePlayerIds = new Set(availablePlayers.map(p => p.id));

        // Helpers
        const getPartnerHistory = (p1Id: number | string, p2Id: number | string) => {
          const id1 = Number(p1Id);
          const id2 = Number(p2Id);
          let count = 0;
          matches.forEach(m => {
            if (m.match_status === 'cancelled') return;
            [m.team_a_id, m.team_b_id].forEach(t => {
              if (!t) return;
              const ids = t.team_players?.map((tp: any) => Number(tp.user_id?.id || tp.user_id)).filter((id: number) => !isNaN(id) && id > 0);
              if (ids && ids.length === 2 && ids.includes(id1) && ids.includes(id2)) count++;
            });
          });
          return count;
        };

        const getFaceoffCount = (pidsA: (number | string)[], pidsB: (number | string)[]) => {
          const keyA = [...pidsA].map(Number).sort((a, b) => a - b).join(",");
          const keyB = [...pidsB].map(Number).sort((a, b) => a - b).join(",");

          let count = 0;
          matches.forEach(m => {
            if (m.match_status === "cancelled") return;
            const mA = m.team_a_id?.team_players?.map((tp: any) => Number(tp.user_id?.id || tp.user_id)).filter((id: number) => !isNaN(id) && id > 0).sort((a: number, b: number) => a - b).join(",") || "";
            const mB = m.team_b_id?.team_players?.map((tp: any) => Number(tp.user_id?.id || tp.user_id)).filter((id: number) => !isNaN(id) && id > 0).sort((a: number, b: number) => a - b).join(",") || "";
            if ((mA === keyA && mB === keyB) || (mA === keyB && mB === keyA)) count++;
          });
          return count;
        };

        const pickBestDouble = (pool4: any[]) => {
          const scoreOption = (tA: any[], tB: any[]) =>
            Math.pow(getPartnerHistory(tA[0].id, tA[1].id), 2) * 50 +
            Math.pow(getPartnerHistory(tB[0].id, tB[1].id), 2) * 50 +
            Math.pow(getFaceoffCount([tA[0].id, tA[1].id], [tB[0].id, tB[1].id]), 2) * 200;

          const opts = [
            { a: [pool4[0], pool4[1]], b: [pool4[2], pool4[3]], score: scoreOption([pool4[0], pool4[1]], [pool4[2], pool4[3]]) },
            { a: [pool4[0], pool4[2]], b: [pool4[1], pool4[3]], score: scoreOption([pool4[0], pool4[2]], [pool4[1], pool4[3]]) },
            { a: [pool4[0], pool4[3]], b: [pool4[1], pool4[2]], score: scoreOption([pool4[0], pool4[3]], [pool4[1], pool4[2]]) },
          ];
          // Shuffle options first to ensure random tie-breaking
          opts.sort(() => Math.random() - 0.5);
          opts.sort((a, b) => a.score - b.score);
          return [opts[0].a, opts[0].b];
        };

        let sideA, sideB;

        if (pairingMode === 'locked') {
          const availTeams = permanentTeams.filter((t: any) =>
            t.players.every((p: any) => availablePlayerIds.has(p.id))
          );

          if (availTeams.length < 2) {
            throw new Error("ต้องการทีมถาวรที่พร้อมเล่นอย่างน้อย 2 ทีม");
          }

          const teamMatchLoad = (team: any) =>
            team.players.reduce((sum: number, p: any) => sum + (effectiveCounts.get(p.id) || 0), 0) / team.players.length;

          const sorted = [...availTeams].sort((a, b) => teamMatchLoad(a) - teamMatchLoad(b));

          sideA = sorted[0];
          const rest = sorted.slice(1);

          const scored = rest.map(sB => {
            const faceoffs = getFaceoffCount(sideA.players.map((p: any) => p.id), sB.players.map((p: any) => p.id));
            const score = faceoffs * 100 + teamMatchLoad(sB) + Math.random();
            return { sideB: sB, score };
          });
          scored.sort((a, b) => a.score - b.score);
          sideB = scored[0].sideB;

        } else {
          // Auto mode
          const availTeams = permanentTeams.filter((t: any) => t.players.every((p: any) => availablePlayerIds.has(p.id)));
          const allTeamPlayerIds = new Set(permanentTeams.flatMap((t: any) => t.players.map((p: any) => p.id)));
          const availIndividuals = availablePlayers.filter(p => !allTeamPlayerIds.has(p.id));

          const possibleSides: any[] = [];

          availTeams.forEach((t: any) => {
            const avgCount = t.players.reduce((sum: number, p: any) => sum + (effectiveCounts.get(p.id) || 0), 0) / t.players.length;
            possibleSides.push({ players: t.players, label: t.label, matchCount: avgCount });
          });

          const sortedIndivs = [...availIndividuals].sort(
            (a, b) => (effectiveCounts.get(a.id) || 0) - (effectiveCounts.get(b.id) || 0)
          );

          if (pPerTeam === 2 && sortedIndivs.length >= 4) {
            const shuffle = (arr: any[]) => {
              const a = [...arr];
              for (let i = a.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
              }
              return a;
            };

            let bestSides: any[] = [];
            let bestScore = Infinity;

            for (let attempt = 0; attempt < 200; attempt++) {
              const shuffled = attempt === 0 ? sortedIndivs : shuffle(sortedIndivs);
              const candidateSides: any[] = [];
              let score = 0;
              let i = 0;
              while (i + 4 <= shuffled.length) {
                const [tA, tB] = pickBestDouble(shuffled.slice(i, i + 4));
                const avgA = tA.reduce((s: number, p: any) => s + (effectiveCounts.get(p.id) || 0), 0) / tA.length;
                const avgB = tB.reduce((s: number, p: any) => s + (effectiveCounts.get(p.id) || 0), 0) / tB.length;
                candidateSides.push({ players: tA, label: tA.map((p: any) => p.username).join(" / "), matchCount: avgA });
                candidateSides.push({ players: tB, label: tB.map((p: any) => p.username).join(" / "), matchCount: avgB });
                // Exponential penalty for partner history
                score += Math.pow(getPartnerHistory(tA[0].id, tA[1].id), 2) * 50 + Math.pow(getPartnerHistory(tB[0].id, tB[1].id), 2) * 50;
                // Exponential penalty for faceoff history
                score += Math.pow(getFaceoffCount([tA[0].id, tA[1].id], [tB[0].id, tB[1].id]), 2) * 200;
                // Heavy penalty for playing too many matches (ensures rotation of entire player pool)
                score += (avgA + avgB) * 20000;
                // Rank Balance: penalize imbalanced teams (high rank + high rank vs low rank + low rank)
                const getSkillScore = (p: any): number => {
                  const r = p.rankings?.[0];
                  if (!r?.rank) return 0; // Bronze 0 (new player / after re-rank)
                  const name = (r.rank || '').toLowerCase();
                  const stars = r.stars || 0;
                  if (name.includes('master'))   return 25 + stars;
                  if (name.includes('diamond'))  return 19 + stars;
                  if (name.includes('platinum')) return 13 + stars;
                  if (name.includes('gold'))     return 8 + stars;
                  if (name.includes('silver'))   return 4 + stars;
                  if (name.includes('bronze'))   return 0 + stars;
                  return 0;
                };
                const avgSkillA = tA.reduce((s: number, p: any) => s + getSkillScore(p), 0) / tA.length;
                const avgSkillB = tB.reduce((s: number, p: any) => s + getSkillScore(p), 0) / tB.length;
                score += Math.abs(avgSkillA - avgSkillB) * 800;
                i += 4;
              }
              if (shuffled.length - i === 2) {
                const slice = shuffled.slice(i, i + 2);
                const avg = slice.reduce((s: number, p: any) => s + (effectiveCounts.get(p.id) || 0), 0) / slice.length;
                candidateSides.push({ players: slice, label: slice.map((p: any) => p.username).join(" / "), matchCount: avg });
                score += Math.pow(getPartnerHistory(slice[0].id, slice[1].id), 2) * 50;
              }
              if (score < bestScore) {
                bestScore = score;
                bestSides = candidateSides;
                if (score === 0) break;
              }
            }
            bestSides.forEach(s => possibleSides.push(s));

          } else if (pPerTeam === 2 && sortedIndivs.length === 2) {
            const avg = sortedIndivs.reduce((s, p) => s + (effectiveCounts.get(p.id) || 0), 0) / sortedIndivs.length;
            possibleSides.push({ players: sortedIndivs, label: sortedIndivs.map(p => p.username).join(" / "), matchCount: avg });
          } else {
            let i = 0;
            while (i + pPerTeam <= sortedIndivs.length) {
              const slice = sortedIndivs.slice(i, i + pPerTeam);
              const avg = slice.reduce((s, p) => s + (effectiveCounts.get(p.id) || 0), 0) / slice.length;
              possibleSides.push({ players: slice, label: slice[0].username, matchCount: avg });
              i += pPerTeam;
            }
          }

          if (possibleSides.length < 2) {
            throw new Error("ทรัพยากรไม่เพียงพอสำหรับจัดแมตซ์ (ต้องการทีมหรือกลุ่มผู้เล่นอิสระอย่างน้อย 2 ฝั่ง)");
          }

          possibleSides.sort((a, b) => a.matchCount - b.matchCount);
          sideA = possibleSides[0];
          const otherSides = possibleSides.slice(1);

          const partnerPenalty = (side: any) =>
            pPerTeam === 2 && side.players.length === 2
              ? Math.pow(getPartnerHistory(side.players[0].id, side.players[1].id), 2) * 100
              : 0;

          const scoredOpponents = otherSides.map(sB => {
            const faceoffs = getFaceoffCount(sideA.players.map((p: any) => p.id), sB.players.map((p: any) => p.id));
            // Exponential penalty for faceoffs + heavy penalty for partner reuse
            const score = Math.pow(faceoffs, 2) * 500 + partnerPenalty(sB) + sB.matchCount * 10 + Math.random();
            return { sideB: sB, score };
          });

          scoredOpponents.sort((a, b) => a.score - b.score);
          sideB = scoredOpponents[0].sideB;
        }

        // 6. DB Creation
        const randNo = () => Math.random().toString(36).substring(2, 10).toUpperCase();

        const teamA = await strapi.entityService.create('api::team.team', {
          data: { tournament_id: tNumericId, team_no: randNo() },
          // @ts-ignore
          transaction: trx,
        });

        await Promise.all(sideA.players.map((p: any) =>
          strapi.entityService.create('api::team-player.team-player', {
            data: { team_id: teamA.id, user_id: p.id },
            // @ts-ignore
            transaction: trx,
          })
        ));

        const teamB = await strapi.entityService.create('api::team.team', {
          data: { tournament_id: tNumericId, team_no: randNo() },
          // @ts-ignore
          transaction: trx,
        });

        await Promise.all(sideB.players.map((p: any) =>
          strapi.entityService.create('api::team-player.team-player', {
            data: { team_id: teamB.id, user_id: p.id },
            // @ts-ignore
            transaction: trx,
          })
        ));

        const matchNo = matches.length + 1;
        const match = await strapi.entityService.create('api::match.match', {
          data: {
            tournament_id: tNumericId,
            round: 1,
            match_no: matchNo,
            team_a_id: teamA.id,
            team_b_id: teamB.id,
            match_status: "upcoming",
            first_serve: "A"
          },
          // @ts-ignore
          transaction: trx,
        });

        return match;
      });
    } finally {
      drawingLocks.delete(tournamentId);
    }
  },

  async createMatchManual(tournamentId: string, playerIdsA: number[], playerIdsB: number[]) {
    return await strapi.db.transaction(async ({ trx }) => {
      // 1. Fetch tournament by documentId to get numeric ID
      const tournaments = (await strapi.entityService.findMany('api::tournament.tournament', {
        filters: { documentId: tournamentId },
      } as any)) as any[];

      const tournament = tournaments[0];
      if (!tournament) throw new Error('Tournament not found');
      const tNumericId = tournament.id;

      const randNo = () => Math.random().toString(36).substring(2, 10).toUpperCase();

      // 2. Create Team A
      const teamA = await strapi.entityService.create('api::team.team', {
        data: { tournament_id: tNumericId, team_no: randNo() },
        // @ts-ignore
        transaction: trx,
      });

      await Promise.all(playerIdsA.map((pid: number) =>
        strapi.entityService.create('api::team-player.team-player', {
          data: { team_id: teamA.id, user_id: pid },
          // @ts-ignore
          transaction: trx,
        })
      ));

      // 3. Create Team B
      const teamB = await strapi.entityService.create('api::team.team', {
        data: { tournament_id: tNumericId, team_no: randNo() },
        // @ts-ignore
        transaction: trx,
      });

      await Promise.all(playerIdsB.map((pid: number) =>
        strapi.entityService.create('api::team-player.team-player', {
          data: { team_id: teamB.id, user_id: pid },
          // @ts-ignore
          transaction: trx,
        })
      ));

      // 4. Get match number
      const matchCount = await strapi.db.query('api::match.match').count({
        where: { tournament_id: tNumericId }
      });

      // 5. Create Match
      const match = await strapi.entityService.create('api::match.match', {
        data: {
          tournament_id: tNumericId,
          round: 1,
          match_no: matchCount + 1,
          team_a_id: teamA.id,
          team_b_id: teamB.id,
          match_status: "upcoming",
          first_serve: "A"
        },
        // @ts-ignore
        transaction: trx,
      });

      return match;
    });
  }
});
