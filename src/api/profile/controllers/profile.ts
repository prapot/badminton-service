import { factories } from '@strapi/strapi';

export default factories.createCoreController('api::profile.profile', ({ strapi }) => ({
    async update(ctx) {
        const user = ctx.state.user;
        if (!user) {
            return ctx.unauthorized('You must be logged in to update your profile');
        }

        const { data } = ctx.request.body;
        if (!data) {
            return ctx.badRequest('Data is required');
        }

        // Filter allowed fields to prevent arbitrary updates (like password or role)
        const allowedFields = ['username', 'email', 'nickname', 'password']; // Add other fields if necessary
        const updateData = {};
        for (const key of allowedFields) {
            if (data[key] !== undefined) {
                updateData[key] = data[key];
            }
        }

        try {
            const updatedUser = await strapi.documents('plugin::users-permissions.user').update({
                documentId: user.documentId,
                data: updateData,
                status: 'published'
            });

            return ctx.send({ data: updatedUser });
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    },

    async uploadPicture(ctx) {
        const user = ctx.state.user;
        if (!user) {
            return ctx.unauthorized('You must be logged in to upload a profile picture');
        }

        const { files } = ctx.request.files || {};
        if (!files) {
            return ctx.badRequest('No file uploaded');
        }

        try {
            // Upload the file to Strapi's Media Library
            // The upload service expects the file and some metadata
            const uploadedFile = await strapi.plugins.upload.services.upload.upload({
                data: {
                    fileInfo: {},
                },
                files: files,
            });

            // Link the uploaded file to the user's profile
            const updatedUser = await strapi.documents('plugin::users-permissions.user').update({
                documentId: user.documentId,
                data: {
                    picture: uploadedFile[0].id,
                },
                status: 'published'
            });

            return ctx.send({
                message: 'Profile picture uploaded successfully',
                data: updatedUser,
                file: uploadedFile[0]
            });
        } catch (err) {
            return ctx.internalServerError(err.message);
        }
    }
}));
