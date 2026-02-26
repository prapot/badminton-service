module.exports = {
    apps: [
        {
            name: 'badminton-service',
            script: 'npm',
            args: 'start',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
