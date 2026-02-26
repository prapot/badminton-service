export default {
    routes: [
        {
            method: 'PUT',
            path: '/profile/update',
            handler: 'profile.update',
            config: {
                policies: [],
                middlewares: [],
            },
        },
        {
            method: 'POST',
            path: '/profile/upload-picture',
            handler: 'profile.uploadPicture',
            config: {
                policies: [],
                middlewares: [],
            },
        },
    ],
};
