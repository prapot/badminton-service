export default {
    routes: [
        {
            method: 'PUT',
            path: '/rankings/upsert',
            handler: 'ranking.upsert',
            config: {
                auth: false,
            },
        },
        {
            method: 'POST',
            path: '/rankings/record-match',
            handler: 'ranking.recordMatch',
            config: {
                auth: false,
            },
        },
        {
            method: 'POST',
            path: '/rankings/revert-match',
            handler: 'ranking.revertMatch',
            config: {
                auth: false,
            },
        },
        {
            method: 'GET',
            path: '/rankings/fix-production',
            handler: 'ranking.fixProduction',
            config: {
                auth: false,
            },
        },
        {
            method: 'POST',
            path: '/rankings/matchmake',
            handler: 'ranking.matchmake',
            config: {
                auth: false,
            },
        },
        {
            method: 'GET',
            path: '/rankings/history/:userId',
            handler: 'ranking.getHistory',
            config: {
                auth: false,
            },
        },
        {
            method: 'POST',
            path: '/rankings/recalibrate-season',
            handler: 'ranking.recalibrateSeason',
            config: {
                auth: false,
            },
        }
    ],
};
