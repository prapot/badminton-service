'use strict';

async function seedUsers() {
    // หา role id ของ Authenticated
    const role = await strapi.query('plugin::users-permissions.role').findOne({
        where: {
            type: 'authenticated',
        },
    });

    if (!role) {
        console.error('Authenticated role not found');
        return;
    }

    const usersMock = [];
    for (let i = 1; i <= 5; i++) {
        const formattedId = String(i).padStart(3, '0');
        usersMock.push({
            username: `member${formattedId}`,
            email: `member${formattedId}@gmail.com`,
            password: 'password',
            confirmed: true,
            blocked: false,
            role: role.id,
        });
    }

    for (const user of usersMock) {
        // เช็คว่ามี user นี้อยู่แล้วหรือยัง
        const existingUser = await strapi.query('plugin::users-permissions.user').findOne({
            where: { username: user.username },
        });

        if (!existingUser) {
            // ใช้ service add เพื่อให้ Strapi จัดการ hash password ให้
            await strapi.plugin('users-permissions').service('user').add(user);
            console.log(`Created user: ${user.username}`);
        } else {
            console.log(`User already exists: ${user.username}`);
        }
    }
}

async function main() {
    const { createStrapi, compileStrapi } = require('@strapi/strapi');

    const appContext = await compileStrapi();
    const app = await createStrapi(appContext).load();

    app.log.level = 'error';

    console.log('Starting to seed mock users...');
    await seedUsers();
    console.log('Seeding finished.');

    await app.destroy();
    process.exit(0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
