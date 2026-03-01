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
        }
    ],
};
