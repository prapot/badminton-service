'use strict';

async function seedTournamentPlayers() {
    // 1. Find or create the Authenticated role
    const role = await strapi.query('plugin::users-permissions.role').findOne({
        where: { type: 'authenticated' },
    });

    if (!role) {
        console.error('Authenticated role not found');
        return;
    }

    // 2. Fetch users member001 to member005
    const userIds = [];
    for (let i = 1; i <= 11; i++) {
        const username = `member${String(i).padStart(3, '0')}`;

        // Find existing user
        let user = await strapi.query('plugin::users-permissions.user').findOne({
            where: { username },
        });

        if (!user) {
            // Fallback: create if missing (standard seed practice)
            const email = `${username}@gmail.com`;
            user = await strapi.plugin('users-permissions').service('user').add({
                username,
                email,
                password: 'password',
                confirmed: true,
                blocked: false,
                role: role.id,
            });
            console.log(`User not found, created new: ${username} (ID: ${user.id})`);
        }
        userIds.push(user.id);
    }

    // 3. Find all tournaments with status "upcoming"
    const upcomingTournaments = await strapi.entityService.findMany('api::tournament.tournament', {
        filters: { tournament_status: 'upcoming' },
    });

    if (upcomingTournaments.length === 0) {
        console.log('No upcoming tournaments found.');
        return;
    }

    console.log(`Found ${upcomingTournaments.length} upcoming tournaments.`);

    // 4. Add users to each upcoming tournament
    for (const tournament of upcomingTournaments) {
        console.log(`Processing tournament: ${tournament.name} (ID: ${tournament.id})`);

        for (const userId of userIds) {
            // Check if user is already in the tournament
            const existingEntry = await strapi.query('api::tournament-player.tournament-player').findOne({
                where: {
                    tournament_id: tournament.documentId,
                    user: userId,
                },
            });

            if (!existingEntry) {
                await strapi.entityService.create('api::tournament-player.tournament-player', {
                    data: {
                        tournament_id: tournament.documentId,
                        user: userId,
                        // Strapi 5 might require publishedAt for some records, but tournament-player schema shows draftAndPublish: false
                    },
                });
                console.log(`  Added user ID ${userId} to tournament ${tournament.id}`);
            } else {
                console.log(`  User ID ${userId} is already in tournament ${tournament.id}`);
            }
        }
    }
}

async function main() {
    const { createStrapi, compileStrapi } = require('@strapi/strapi');

    const appContext = await compileStrapi();
    const app = await createStrapi(appContext).load();

    app.log.level = 'error';

    console.log('Starting to seed tournament players...');
    try {
        await seedTournamentPlayers();
        console.log('Seeding finished successfully.');
    } catch (error) {
        console.error('Error during seeding:', error);
    } finally {
        await app.destroy();
        process.exit(0);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});

//node scripts/seed-tournament-players.js