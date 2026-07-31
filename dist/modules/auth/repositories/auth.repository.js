export class DemoAuthRepository {
    async signIn(input) {
        return {
            accessToken: `demo.${Buffer.from(input.email).toString('base64url')}`,
            user: { name: input.email.split('@')[0], email: input.email }
        };
    }
}
